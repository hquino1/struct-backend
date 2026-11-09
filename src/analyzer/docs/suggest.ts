import {
  MAX_SUGGESTIONS,
  isDocumentable,
  type DocSuggestion,
} from '../../docs/docs.entity.js';
import type { Component } from '../architecture.js';
import { isTestFile } from '../repo-digest.js';
import type { ViewGraph, ViewId } from '../views/view-graph.js';

// Which repository files import which, from the code scan.
export class ImportGraph {
  readonly importers = new Map<string, Set<string>>();
  readonly imports = new Map<string, Set<string>>();

  add(from: string, to: string) {
    if (from === to) return;
    const add = (map: Map<string, Set<string>>, key: string, value: string) =>
      (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);
    add(this.importers, to, from);
    add(this.imports, from, to);
  }
}

// HTTP routes per file, from the API view, with how many call sites reach each file's routes.
export function endpointsByFile(api: ViewGraph | undefined) {
  const byFile = new Map<string, { routes: string[]; callSites: number }>();
  for (const node of api?.nodes ?? []) {
    if (node.kind !== 'endpoint' || !node.path) continue;
    const entry = byFile.get(node.path) ?? { routes: [], callSites: 0 };
    entry.routes.push(node.name);
    entry.callSites += Number(/(\d+) call sites?/.exec(node.detail)?.[1] ?? 0);
    byFile.set(node.path, entry);
  }
  return byFile;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

// Ranks the files a newcomer should read first: component entry points, the files behind
// the most-called endpoints, the data model, files much of the code imports, and the
// infrastructure. Each reason says why, so the user can judge the pick.
export function suggestFiles(input: {
  paths: string[];
  components: Component[];
  views: Partial<Record<ViewId, ViewGraph>>;
  imports: ImportGraph;
  limit?: number;
}): DocSuggestion[] {
  const files = new Set(
    input.paths.filter((p) => isDocumentable(p) && !isTestFile(p)),
  );
  const scores = new Map<
    string,
    { score: number; reasons: [number, string][] }
  >();
  const credit = (path: string | undefined, score: number, reason: string) => {
    if (!path || !files.has(path)) return;
    const entry = scores.get(path) ?? { score: 0, reasons: [] };
    entry.score += score;
    entry.reasons.push([score, reason]);
    scores.set(path, entry);
  };

  for (const c of input.components) {
    credit(c.entryPoint, 100, `Entry point of ${c.name}`);
  }
  for (const [path, { routes, callSites }] of endpointsByFile(
    input.views.api,
  )) {
    credit(
      path,
      15 * routes.length + 5 * callSites,
      callSites
        ? `Serves ${plural(routes.length, 'endpoint')} called from ${plural(callSites, 'place')}`
        : `Serves ${plural(routes.length, 'endpoint')}`,
    );
  }
  for (const [path, importers] of input.imports.importers) {
    if (importers.size >= 3) {
      credit(path, 4 * importers.size, `Imported by ${importers.size} files`);
    }
  }
  const viewFiles = (view: ViewId) =>
    new Set(input.views[view]?.nodes.flatMap((n) => n.path ?? []));
  for (const path of viewFiles('schema')) {
    credit(path, 40, 'Defines the data model');
  }
  for (const path of viewFiles('infrastructure')) {
    credit(path, 15, 'Defines cloud infrastructure');
  }
  for (const path of viewFiles('ci-cd')) {
    credit(path, 10, 'Defines a CI/CD workflow');
  }

  return [...scores]
    .sort(([a, x], [b, y]) => y.score - x.score || a.localeCompare(b))
    .slice(0, input.limit ?? MAX_SUGGESTIONS)
    .map(([path, { reasons }]) => ({
      path,
      reason: reasons
        .sort((a, b) => b[0] - a[0])
        .slice(0, 2)
        .map(([, reason]) => reason)
        .join(' · '),
    }));
}
