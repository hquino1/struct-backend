import { basename, dirOf, readConfig, withComponent } from '../shared.js';
import { categorize, type Collected, type Source } from './model.js';

// Terraform resources and modules, connected by the references between them
// (`aws_lambda_function.api.arn`, `module.network.vpc_id`). A block finder rather than a
// full HCL parser: the graph only needs block names and the references inside them.

const BLOCK =
  /^[ \t]*(resource|module)[ \t]+"([^"]+)"(?:[ \t]+"([^"]+)")?[ \t]*\{/gm;
const REFERENCE = /\b(module\.[\w-]+|[a-z][a-z0-9]*_[a-z0-9_]+\.[\w-]+)/g;
const MODULE_SOURCE = /^\s*source\s*=\s*"([^"]+)"/m;

// The text up to the brace that closes the one at `open`. Interpolations and JSON policies
// inside strings are balanced, so plain counting holds up.
function blockBody(source: string, open: number) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0)
      return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

interface Block {
  key: string; // "aws_s3_bucket.assets" or "module.network"
  id: string;
  body: string;
  path: string;
}

export const terraform: Source = async ({ repoDir, paths, findComponent }) => {
  const collected: Collected = { resources: [], links: [] };
  // Terraform resolves names per directory (one module), so each is its own namespace.
  const byDir = new Map<string, Block[]>();
  for (const path of paths.filter((p) => p.endsWith('.tf'))) {
    const source = await readConfig(repoDir, path);
    if (!source) continue;
    const dir = dirOf(path);
    const blocks = byDir.get(dir) ?? [];
    byDir.set(dir, blocks);
    for (const m of source.matchAll(BLOCK)) {
      const [whole, keyword, first, second] = m;
      const body = blockBody(source, m.index + whole.length - 1);
      const isModule = keyword === 'module';
      if (!isModule && !second) continue;
      const key = isModule ? `module.${first}` : `${first}.${second}`;
      const id = `tf:${dir}:${key}`;
      blocks.push({ key, id, body, path });
      const moduleSource = isModule ? MODULE_SOURCE.exec(body)?.[1] : undefined;
      collected.resources.push({
        id,
        name: isModule ? first! : second!,
        type: isModule ? 'module' : first!,
        category: isModule ? 'other' : categorize(first!),
        detail: isModule
          ? `Terraform module · ${moduleSource ?? 'inline'}`
          : `${first} · ${basename(path)}`,
        path,
        ...withComponent(findComponent(dir, body)),
      });
    }
  }

  for (const blocks of byDir.values()) {
    const ids = new Map(blocks.map((b) => [b.key, b.id]));
    for (const block of blocks) {
      const seen = new Set<string>();
      for (const [, ref] of block.body.matchAll(REFERENCE)) {
        const target = ids.get(ref!);
        if (!target || target === block.id || seen.has(target)) continue;
        seen.add(target);
        collected.links.push({ from: block.id, to: target, label: 'uses' });
      }
    }
  }
  return collected;
};
