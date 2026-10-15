import { readText } from '../../repo-digest.js';
import { isRecord, readYaml } from '../shared.js';

// Server routes, found per framework by the way each declares them. Paths are normalized
// so `:id`, `{id}`, `[id]`, and `<int:id>` all read `:id`.

export interface Route {
  method: string; // GET, POST, ... or ALL
  path: string;
  file: string;
  line: number;
  handler?: string;
  framework: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const MAX_FILE_BYTES = 256_000;

export function normalizePath(raw: string) {
  const path = raw
    .split(/[?#]/)[0]!
    .replace(/\[\[?\.\.\.(\w+)\]?\]/g, ':$1') // Next catch-all
    .replace(/\[(\w+)\]/g, ':$1') // Next dynamic segment
    .replace(/\{(\w+)(?::[^}]*)?\}/g, ':$1') // OpenAPI, FastAPI, Spring
    .replace(/<(?:\w+:)?(\w+)>/g, ':$1') // Flask, Django
    .replace(/\/+/g, '/');
  const trimmed = path.replace(/\/$/, '');
  return trimmed.startsWith('/') ? trimmed || '/' : `/${trimmed}`;
}

const join = (...parts: (string | undefined)[]) =>
  normalizePath(parts.filter(Boolean).join('/'));

const lineAt = (text: string, index: number) =>
  text.slice(0, index).split('\n').length;

const SOURCE = /\.([cm]?[jt]sx?|py|java|kt|go)$/;
const TEST = /\.(spec|test)\.|(^|\/)(tests?|__tests__|__mocks__)\//;

// Express, Fastify, Koa, Hono, and friends: only in files that use one, so an API client's
// `api.get('/x')` isn't mistaken for a route.
const JS_SERVER =
  /from\s+['"](express|fastify|koa|@koa\/router|koa-router|hono|restify|polka|@hapi\/hapi|@elysiajs\/\w+|elysia)['"]|require\(\s*['"](express|fastify|koa|koa-router|hono|restify)['"]\s*\)|\bexpress\.Router\(|\bnew\s+(Hono|Elysia|Router)\(/;
const JS_ROUTE =
  /\b([\w$]+)\.(get|post|put|patch|delete|options|head|all)\(\s*(['"`])(\/[^'"`]*)\3\s*,/gi;
const JS_CHAINED =
  /\.route\(\s*(['"`])(\/[^'"`]*)\1\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete|all)\s*\((?:[^()]|\([^()]*\))*\))+)/gi;
const HAPI =
  /method\s*:\s*['"](\w+)['"][^}]{0,200}?path\s*:\s*['"]([^'"]+)['"]|path\s*:\s*['"]([^'"]+)['"][^}]{0,200}?method\s*:\s*['"](\w+)['"]/g;

const NEST_CONTROLLER =
  /@Controller\(\s*(?:['"`]([^'"`]*)['"`]|\{[^}]*path\s*:\s*['"`]([^'"`]*)['"`][^}]*\})?\s*\)/g;
const NEST_ROUTE =
  /@(Get|Post|Put|Patch|Delete|Options|Head|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)((?:\s*@\w+(?:\((?:[^()]|\([^()]*\))*\))?)*)\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/g;
const NEST_PREFIX = /setGlobalPrefix\(\s*['"`]([^'"`]+)['"`]/;

const NEXT_APP_ROUTE = /(^|\/)app\/(.*)\/?route\.[cm]?[jt]sx?$/;
const NEXT_PAGES_API = /(^|\/)pages\/(api\/.*)\.[cm]?[jt]sx?$/;
const NEXT_METHOD =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;

const PY_DECORATOR =
  /@([\w.]+)\.(get|post|put|patch|delete|options|head|api_route|route)\(\s*['"]([^'"]*)['"]([^)]*)\)\s*\n(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+(\w+)/g;
const PY_PREFIX =
  /(?:APIRouter|Blueprint)\([^)]*?(?:prefix|url_prefix)\s*=\s*['"]([^'"]+)['"]/;
const DJANGO_PATH =
  /\b(?:re_)?path\(\s*r?['"]\^?([^'"]*?)\$?['"]\s*,\s*([\w.]+)/g;

const SPRING_CLASS =
  /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/;
const SPRING_ROUTE =
  /@(Get|Post|Put|Patch|Delete|Request)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:\{\s*)?"([^"]*)"[^)]*\))?[\s\S]{0,300}?\b(?:fun|public|private|protected)?\s*[\w<>[\],\s]*?\b(\w+)\s*\(/g;

const GO_ROUTE =
  /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle|Group)\(\s*"([^"]*)"/g;

const OPENAPI = /(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i;

function scan(
  path: string,
  text: string,
  prefixes: Map<string, string>,
): Route[] {
  const routes: Route[] = [];
  const add = (route: Route) => routes.push(route);

  if (path.endsWith('.py')) {
    const prefix = PY_PREFIX.exec(text)?.[1];
    for (const m of text.matchAll(PY_DECORATOR)) {
      const [, , verb, routePath, rest, handler] = m;
      const methods =
        verb === 'route' || verb === 'api_route'
          ? (/methods\s*=\s*\[([^\]]*)\]/.exec(rest!)?.[1]?.match(/\w+/g) ?? [
              'GET',
            ])
          : [verb!];
      for (const method of methods) {
        add({
          method: method.toUpperCase(),
          path: join(prefix, routePath),
          file: path,
          line: lineAt(text, m.index),
          handler: handler!,
          framework: verb === 'route' ? 'Flask' : 'FastAPI',
        });
      }
    }
    if (/(^|\/)urls\.py$/.test(path)) {
      for (const m of text.matchAll(DJANGO_PATH)) {
        if (/include\(/.test(m[2]!)) continue;
        add({
          method: 'ALL',
          path: join(m[1]),
          file: path,
          line: lineAt(text, m.index),
          handler: m[2]!,
          framework: 'Django',
        });
      }
    }
    return routes;
  }

  if (/\.(java|kt)$/.test(path)) {
    const base = SPRING_CLASS.exec(text)?.[1];
    for (const m of text.matchAll(SPRING_ROUTE)) {
      if (m[1] === 'Request' && m.index === SPRING_CLASS.exec(text)?.index)
        continue;
      add({
        method: m[1] === 'Request' ? 'ALL' : m[1]!.toUpperCase(),
        path: join(base, m[2]),
        file: path,
        line: lineAt(text, m.index),
        handler: m[3]!,
        framework: 'Spring',
      });
    }
    return routes;
  }

  if (path.endsWith('.go')) {
    for (const m of text.matchAll(GO_ROUTE)) {
      if (m[1] === 'Group') continue;
      // Go 1.22 patterns carry the method: "GET /items/{id}".
      const pattern = /^([A-Z]+)\s+(\/.*)$/.exec(m[2]!);
      const generic = m[1] === 'HandleFunc' || m[1] === 'Handle';
      if (!pattern && !m[2]!.startsWith('/')) continue;
      add({
        method: pattern ? pattern[1]! : generic ? 'ALL' : m[1]!.toUpperCase(),
        path: normalizePath(pattern ? pattern[2]! : m[2]!),
        file: path,
        line: lineAt(text, m.index),
        framework: 'Go',
      });
    }
    return routes;
  }

  // JavaScript and TypeScript.
  if (text.includes('@Controller(')) {
    const controllers = [...text.matchAll(NEST_CONTROLLER)];
    for (const m of text.matchAll(NEST_ROUTE)) {
      const controller = controllers.filter((c) => c.index < m.index).at(-1);
      add({
        method: m[1] === 'All' ? 'ALL' : m[1]!.toUpperCase(),
        path: join(
          prefixes.get('nest'),
          controller?.[1] ?? controller?.[2],
          m[2],
        ),
        file: path,
        line: lineAt(text, m.index),
        handler: m[4]!,
        framework: 'NestJS',
      });
    }
  }
  const next = NEXT_APP_ROUTE.exec(path) ?? NEXT_PAGES_API.exec(path);
  if (next) {
    const segments = next[2]!
      .split('/')
      .filter(
        (s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@') && s !== 'index',
      );
    const methods = [...text.matchAll(NEXT_METHOD)].map((m) => m[1]!);
    for (const method of NEXT_PAGES_API.test(path) ? ['ALL'] : methods) {
      add({
        method,
        path: join(...segments),
        file: path,
        line: 1,
        handler: method === 'ALL' ? 'default' : method,
        framework: 'Next.js',
      });
    }
  }
  if (JS_SERVER.test(text)) {
    for (const m of text.matchAll(JS_ROUTE)) {
      add({
        method: m[2]!.toUpperCase() === 'ALL' ? 'ALL' : m[2]!.toUpperCase(),
        path: normalizePath(m[4]!),
        file: path,
        line: lineAt(text, m.index),
        framework: 'HTTP server',
      });
    }
    for (const m of text.matchAll(JS_CHAINED)) {
      for (const verb of m[3]!.match(/get|post|put|patch|delete|all/gi) ?? []) {
        add({
          method: verb.toUpperCase(),
          path: normalizePath(m[2]!),
          file: path,
          line: lineAt(text, m.index),
          framework: 'HTTP server',
        });
      }
    }
    for (const m of text.matchAll(HAPI)) {
      const method = (m[1] ?? m[4])!.toUpperCase();
      if (!METHODS.includes(method) && method !== '*') continue;
      add({
        method: method === '*' ? 'ALL' : method,
        path: normalizePath((m[2] ?? m[3])!),
        file: path,
        line: lineAt(text, m.index),
        framework: 'hapi',
      });
    }
  }
  return routes;
}

async function openApiRoutes(repoDir: string, path: string): Promise<Route[]> {
  const spec = await readYaml(repoDir, path); // JSON is YAML too
  const paths = spec && isRecord(spec['paths']) ? spec['paths'] : undefined;
  if (!paths) return [];
  return Object.entries(paths).flatMap(([routePath, item]) =>
    isRecord(item)
      ? Object.keys(item)
          .filter((k) => METHODS.includes(k.toUpperCase()))
          .map((method) => {
            const operation = item[method];
            const operationId = isRecord(operation)
              ? operation['operationId']
              : undefined;
            return {
              method: method.toUpperCase(),
              path: normalizePath(routePath),
              file: path,
              line: 1,
              ...(typeof operationId === 'string' && { handler: operationId }),
              framework: 'OpenAPI',
            };
          })
      : [],
  );
}

export async function findRoutes(repoDir: string, paths: string[]) {
  const sources = paths.filter((p) => SOURCE.test(p) && !TEST.test(p));
  const texts = new Map<string, string>();
  for (const path of sources) {
    const text = await readText(repoDir, path, MAX_FILE_BYTES).catch(
      () => undefined,
    );
    if (text) texts.set(path, text);
  }
  // NestJS's global prefix applies to every controller in the app.
  const nestPrefix = [...texts.values()]
    .map((t) => NEST_PREFIX.exec(t)?.[1])
    .find(Boolean);
  const prefixes = new Map(nestPrefix ? [['nest', nestPrefix]] : []);

  const routes = [...texts].flatMap(([path, text]) =>
    scan(path, text, prefixes),
  );
  // A spec only adds what the code doesn't already declare.
  const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
  for (const path of paths.filter((p) => OPENAPI.test(p))) {
    for (const route of await openApiRoutes(repoDir, path)) {
      if (!known.has(`${route.method} ${route.path}`)) routes.push(route);
    }
  }
  return { routes, texts };
}
