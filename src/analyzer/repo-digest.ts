import { open } from 'node:fs/promises';
import { posix, join } from 'node:path';
import type { Component } from './architecture.js';
import { languageOf } from './repository.js';

// Text summaries of a cloned repo for Claude. Budgets are in characters (~4 per token), so
// the map step stays around 100K input tokens however large the repository is.

const MAP_BUDGET_CHARS = 400_000;
const MAX_CHARS_PER_FILE = 12_000;
const MAX_TREE_LINES = 3_000;
// Source files larger than this are skipped when tracing imports (minified or generated).
const MAX_TRACE_FILE_BYTES = 256_000;

async function readText(dir: string, path: string, maxBytes: number) {
  const handle = await open(join(dir, path), 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const slice = buffer.subarray(0, bytesRead);
    // A NUL byte means a binary file, which tells Claude nothing.
    return slice.includes(0) ? undefined : slice.toString('utf8');
  } finally {
    await handle.close();
  }
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const depth = (path: string) => path.split('/').length;

// The whole tree when it is small; otherwise file counts per directory, three levels deep.
function fileTree(paths: string[]) {
  if (paths.length <= MAX_TREE_LINES) return paths.join('\n');
  const counts = new Map<string, number>();
  for (const path of paths) {
    const dir = path.split('/').slice(0, -1).slice(0, 3).join('/') || '.';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .slice(0, MAX_TREE_LINES)
    .map(([dir, n]) => `${dir}/ (${n} files)`)
    .join('\n');
}

// Files that say the most about a system's shape, most telling first.
const KEY_FILE_RULES: ((path: string) => boolean)[] = [
  (p) => /^readme(\.md)?$/i.test(p),
  (p) =>
    /^(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|.+\.csproj)$/.test(
      basename(p),
    ),
  (p) =>
    /^(Dockerfile.*|docker-compose.*\.ya?ml|compose\.ya?ml|serverless\.ya?ml|template\.ya?ml|cdk\.json|vercel\.json|netlify\.toml|Procfile|.+\.tf)$/.test(
      basename(p),
    ) || /^\.github\/workflows\/.+\.ya?ml$/.test(p),
  (p) =>
    /^((next|vite|nuxt|astro|svelte|remix|webpack)\.config\.\w+|nest-cli\.json|angular\.json|schema\.prisma|.+\.graphql|openapi\.(json|ya?ml)|\.env\.example)$/.test(
      basename(p),
    ),
  (p) =>
    depth(p) <= 4 &&
    /^(main|index|app|server|handler|lambda|worker|wsgi|asgi|manage)\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|cs)$/.test(
      basename(p),
    ),
  (p) =>
    /(^|\/)(routes|controllers|api|handlers|endpoints)\//.test(p) &&
    languageOf(p) !== undefined,
];

// Input for the map step: the file tree plus the contents of the most telling files.
export async function buildMapDigest(dir: string, paths: string[]) {
  const chosen: string[] = [];
  const seen = new Set<string>();
  for (const rule of KEY_FILE_RULES) {
    const matches = paths
      .filter((p) => !seen.has(p) && rule(p))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    for (const p of matches) {
      seen.add(p);
      chosen.push(p);
    }
  }

  const parts = [`<file_tree>\n${fileTree(paths)}\n</file_tree>`];
  let used = parts[0].length;
  for (const path of chosen) {
    const text = await readText(dir, path, MAX_CHARS_PER_FILE * 2);
    if (!text?.trim()) continue;
    const body =
      text.length > MAX_CHARS_PER_FILE
        ? `${text.slice(0, MAX_CHARS_PER_FILE)}\n[... truncated]`
        : text;
    const block = `<file path="${path}">\n${body}\n</file>`;
    if (used + block.length > MAP_BUDGET_CHARS) continue;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

const normalize = (path: string) =>
  path.trim().replace(/^\.\//, '').replace(/\/+$/, '');

// Maps each path to the component whose `paths` entry is the longest prefix of it.
export function componentLocator(components: Component[]) {
  const prefixes = components
    .flatMap((c) => c.paths.map((p) => ({ id: c.id, prefix: normalize(p) })))
    .filter((p) => p.prefix && p.prefix !== '.')
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return (path: string) =>
    prefixes.find(
      ({ prefix }) => path === prefix || path.startsWith(`${prefix}/`),
    )?.id;
}

const JS_IMPORT =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const PY_IMPORT =
  /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm;
const ENV_VAR =
  /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]|import\.meta\.env(?:\.|\[['"])([A-Z][A-Z0-9_]+)|os\.environ(?:\.get)?[([]\s*['"]([A-Z][A-Z0-9_]+)['"]|os\.getenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]|\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;
const URL_HOST = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster crypto dns events fs http http2 https module net os path perf_hooks process querystring readline stream string_decoder timers tls tty url util v8 vm worker_threads zlib'.split(
    ' ',
  ),
);
const PY_STDLIB = new Set(
  'abc argparse asyncio base64 collections contextlib copy csv dataclasses datetime enum functools glob hashlib io itertools json logging math os pathlib random re shutil signal subprocess sys tempfile threading time traceback typing unittest urllib uuid'.split(
    ' ',
  ),
);
const IGNORED_HOSTS =
  /(^|\.)(localhost|example\.com|w3\.org|schema\.org|github\.com|githubusercontent\.com)$/;

const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

// Resolves a relative or `@/` / `~/` aliased JS import to a repository file.
function resolveJsImport(from: string, spec: string, files: Set<string>) {
  let base: string;
  if (spec.startsWith('.')) {
    base = posix.join(posix.dirname(from), spec);
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    // These aliases conventionally point at the package's src/ directory.
    const parts = from.split('/');
    const src = parts.lastIndexOf('src');
    base = posix.join(
      src >= 0 ? parts.slice(0, src + 1).join('/') : '',
      spec.slice(2),
    );
  } else {
    return undefined;
  }
  // TypeScript ESM imports name the compiled `.js` file.
  for (const candidate of new Set([base, base.replace(/\.(m|c)?js$/, '')])) {
    for (const suffix of RESOLVE_SUFFIXES) {
      if (files.has(candidate + suffix)) return candidate + suffix;
    }
  }
  return undefined;
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// The package a bare import names, or undefined for builtins and things that aren't
// package names (e.g. strings that only look like imports).
const packageName = (spec: string) => {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return spec.startsWith('node:') ||
    NODE_BUILTINS.has(name) ||
    !NPM_NAME.test(name)
    ? undefined
    : name;
};

// Tests import fixtures and mocks, which would read as real dependencies.
const isTestFile = (path: string) =>
  /\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__|__mocks__)\/|(^|\/)test_[^/]*\.py$|_test\.py$/.test(
    path,
  );

interface ComponentFacts {
  files: number;
  dependsOn: Map<string, { count: number; example: string }>;
  packages: Map<string, number>;
  envVars: Set<string>;
  hosts: Set<string>;
}

const increment = (map: Map<string, number>, key: string) =>
  map.set(key, (map.get(key) ?? 0) + 1);

const top = (map: Map<string, number>, n: number) =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => `${key} (${count})`)
    .join(', ');

// Input for the trace step: per component, which other components its code imports and
// which packages, environment variables, and hosts it uses. Computed in code, so Claude
// infers connections from evidence rather than guessing from file names.
export async function buildTraceDigest(
  dir: string,
  paths: string[],
  components: Component[],
) {
  const locate = componentLocator(components);
  const files = new Set(paths);
  const topLevelNames = new Set(paths.map((p) => p.split('/')[0]));
  const facts = new Map<string, ComponentFacts>(
    components.map((c) => [
      c.id,
      {
        files: 0,
        dependsOn: new Map(),
        packages: new Map(),
        envVars: new Set(),
        hosts: new Set(),
      },
    ]),
  );

  for (const path of paths) {
    const language = languageOf(path);
    const owner = locate(path);
    if (!language || !owner) continue;
    const fact = facts.get(owner)!;
    fact.files++;

    const isJs = language === 'TypeScript' || language === 'JavaScript';
    if (
      !isJs &&
      language !== 'Python' &&
      language !== 'Vue' &&
      language !== 'Svelte'
    )
      continue;
    if (isTestFile(path)) continue;
    const text = await readText(dir, path, MAX_TRACE_FILE_BYTES);
    if (!text) continue;

    if (language === 'Python') {
      for (const m of text.matchAll(PY_IMPORT)) {
        const module = (m[1] ?? m[2]).split('.')[0];
        if (!PY_STDLIB.has(module) && !topLevelNames.has(module)) {
          increment(fact.packages, module);
        }
      }
    } else {
      for (const m of text.matchAll(JS_IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        const target = resolveJsImport(path, spec, files);
        if (target) {
          const targetOwner = locate(target);
          if (targetOwner && targetOwner !== owner) {
            const edge = fact.dependsOn.get(targetOwner);
            if (edge) edge.count++;
            else
              fact.dependsOn.set(targetOwner, {
                count: 1,
                example: `${path} → ${target}`,
              });
          }
        } else if (!spec.startsWith('.') && !/^[@~]\//.test(spec)) {
          const name = packageName(spec);
          if (name) increment(fact.packages, name);
        }
      }
    }
    for (const m of text.matchAll(ENV_VAR)) {
      const name = m.slice(1).find(Boolean);
      if (name && fact.envVars.size < 40) fact.envVars.add(name);
    }
    for (const m of text.matchAll(URL_HOST)) {
      const host = m[1].toLowerCase();
      if (!IGNORED_HOSTS.test(host) && fact.hosts.size < 20)
        fact.hosts.add(host);
    }
  }

  const sections = components.map((c) => {
    const fact = facts.get(c.id)!;
    const lines = [
      `## ${c.id} — ${c.name} (${c.type}, ${fact.files} source files)`,
    ];
    if (fact.dependsOn.size) {
      lines.push(
        `Imports code from: ${[...fact.dependsOn]
          .map(([id, e]) => `${id} ×${e.count} (e.g. ${e.example})`)
          .join('; ')}`,
      );
    }
    if (fact.packages.size) lines.push(`Packages: ${top(fact.packages, 25)}`);
    if (fact.envVars.size)
      lines.push(`Environment variables: ${[...fact.envVars].join(', ')}`);
    if (fact.hosts.size) lines.push(`URLs: ${[...fact.hosts].join(', ')}`);
    if (lines.length === 1)
      lines.push('No code evidence found in this repository.');
    return lines.join('\n');
  });

  return {
    digest: sections.join('\n\n'),
    fileCounts: Object.fromEntries(
      [...facts].map(([id, fact]) => [id, fact.files]),
    ),
  };
}
