import { posix } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import type { Component } from '../architecture.js';
import { componentLocator, readText } from '../repo-digest.js';

// Helpers the view extractors share: reading config files and tying what they describe
// back to the architecture's components.

export type YamlMap = Record<string, unknown>;

export const isRecord = (value: unknown): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];

export const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export const dirOf = (path: string) => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};

// Every string inside a value, e.g. a job's `run` scripts and `working-directory`s.
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (isRecord(value))
    Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

// The component some config is about, judged by the repo paths it mentions
// (`working-directory: backend`, `cd frontend && npm ci`, `build: ../api`). Relative paths
// resolve against `baseDir`, the directory of the file they appear in.
export function componentFinder(components: Component[]) {
  const locate = componentLocator(components);
  return (baseDir: string, ...values: unknown[]) => {
    const hits = new Map<string, number>();
    for (const s of allStrings(values)) {
      for (const token of s.split(/[\s'"`=,;:()[\]{}$]+/)) {
        let path = token
          .replace(/^\/+(?=\.)/, '')
          .replace(/(\/\*\*?)+(\/\*[^/]*)?$/, '');
        if (/^\.\.?\//.test(path)) path = posix.join(baseDir, path);
        path = path.replace(/^\.\//, '').replace(/\/+$/, '');
        if (!path || path.startsWith('..')) continue;
        const id = locate(path);
        if (id) hits.set(id, (hits.get(id) ?? 0) + 1);
      }
    }
    return [...hits].sort(([, a], [, b]) => b - a)[0]?.[0];
  };
}
export type ComponentFinder = ReturnType<typeof componentFinder>;

export const withComponent = (componentId: string | undefined) =>
  componentId ? { componentId } : {};

const MAX_CONFIG_BYTES = 512_000;

export const readConfig = (repoDir: string, path: string) =>
  readText(repoDir, path, MAX_CONFIG_BYTES).catch(() => undefined);

// `merge` resolves `<<: *anchor`; tags like CloudFormation's `!Ref` resolve to their plain
// value, which is enough to spot the names they reference.
const YAML_OPTIONS = { merge: true, logLevel: 'error' } as const;

export async function readYaml(repoDir: string, path: string) {
  const content = await readConfig(repoDir, path);
  if (!content) return undefined;
  try {
    const doc: unknown = parse(content, YAML_OPTIONS);
    return isRecord(doc) ? doc : undefined;
  } catch {
    // An invalid file only loses its own part of the view.
    return undefined;
  }
}

// Every document in a multi-document file (Kubernetes manifests), skipping broken ones.
export async function readYamlDocuments(repoDir: string, path: string) {
  const content = await readConfig(repoDir, path);
  if (!content) return [];
  try {
    return parseAllDocuments(content, YAML_OPTIONS).flatMap((doc) => {
      if (!('errors' in doc) || doc.errors.length) return [];
      const value: unknown = doc.toJS();
      return isRecord(value) ? [value] : [];
    });
  } catch {
    return [];
  }
}
