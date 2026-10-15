import { parse as parseToml } from 'smol-toml';
import {
  dirOf,
  isRecord,
  readConfig,
  text,
  withComponent,
  type YamlMap,
} from '../shared.js';
import type { Category, Collected, Source } from './model.js';

// Cloudflare Workers from wrangler config, with the stores and services they bind to.

const WRANGLER = /(^|\/)wrangler\.(toml|json|jsonc)$/;

// Binding lists in a wrangler config, and what each holds.
const BINDINGS: {
  key: string;
  category: Category;
  label: string;
  name: (b: YamlMap) => unknown;
}[] = [
  {
    key: 'kv_namespaces',
    category: 'data',
    label: 'KV namespace',
    name: (b) => b['binding'],
  },
  {
    key: 'd1_databases',
    category: 'data',
    label: 'D1 database',
    name: (b) => b['database_name'] ?? b['binding'],
  },
  {
    key: 'r2_buckets',
    category: 'data',
    label: 'R2 bucket',
    name: (b) => b['bucket_name'] ?? b['binding'],
  },
  {
    key: 'services',
    category: 'compute',
    label: 'Worker',
    name: (b) => b['service'],
  },
  {
    key: 'hyperdrive',
    category: 'data',
    label: 'Hyperdrive',
    name: (b) => b['binding'],
  },
  {
    key: 'vectorize',
    category: 'data',
    label: 'Vectorize index',
    name: (b) => b['index_name'] ?? b['binding'],
  },
];

// JSONC: drop comments outside strings, then trailing commas.
const parseJsonc = (source: string): unknown =>
  JSON.parse(
    source
      .replace(
        /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (m, str: string | undefined) => str ?? '',
      )
      .replace(/,(\s*[}\]])/g, '$1'),
  );

const list = (value: unknown): YamlMap[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

export const cloudflare: Source = async ({ repoDir, paths, findComponent }) => {
  const collected: Collected = { resources: [], links: [] };
  for (const path of paths.filter((p) => WRANGLER.test(p))) {
    const source = await readConfig(repoDir, path);
    if (!source) continue;
    let config: unknown;
    try {
      config = path.endsWith('.toml') ? parseToml(source) : parseJsonc(source);
    } catch {
      continue;
    }
    if (!isRecord(config)) continue;
    const dir = dirOf(path);
    const worker = `cf:${path}`;
    const main = text(config['main']);
    collected.resources.push({
      id: worker,
      name: text(config['name']) ?? 'Worker',
      type: 'Cloudflare Worker',
      category: 'compute',
      detail: ['Cloudflare Worker', main].filter(Boolean).join(' · '),
      path,
      ...withComponent(
        findComponent(
          dir,
          main && (main.startsWith('.') ? main : `./${main}`),
          `./`,
        ),
      ),
    });

    const bind = (
      category: Category,
      label: string,
      name: string,
      edge: string,
      inbound = false,
    ) => {
      const id = `${worker}:${label}:${name}`;
      if (!collected.resources.some((r) => r.id === id)) {
        collected.resources.push({
          id,
          name,
          type: label,
          category,
          detail: `${label} · Cloudflare`,
          path,
        });
      }
      collected.links.push(
        inbound
          ? { from: id, to: worker, label: edge }
          : { from: worker, to: id, label: edge },
      );
    };
    for (const { key, category, label, name } of BINDINGS) {
      for (const binding of list(config[key])) {
        const value = text(name(binding));
        if (value) bind(category, label, value, 'binding');
      }
    }
    const durable = isRecord(config['durable_objects'])
      ? list(config['durable_objects']['bindings'])
      : [];
    for (const binding of durable) {
      const value = text(binding['class_name']) ?? text(binding['name']);
      if (value) bind('data', 'Durable Object', value, 'binding');
    }
    const queues = isRecord(config['queues']) ? config['queues'] : {};
    for (const producer of list(queues['producers'])) {
      const queue = text(producer['queue']);
      if (queue) bind('messaging', 'Queue', queue, 'sends to');
    }
    for (const consumer of list(queues['consumers'])) {
      const queue = text(consumer['queue']);
      if (queue) bind('messaging', 'Queue', queue, 'triggers', true);
    }
  }
  return collected;
};
