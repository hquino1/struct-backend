import { componentLocator } from '../../repo-digest.js';
import type {
  ViewEdge,
  ViewExtractor,
  ViewGraph,
  ViewNode,
} from '../view-graph.js';
import { buildCallGraph, SOURCE, type Decl } from './graph.js';

// Which functions call which, for JavaScript and TypeScript, as resolved by the call graph.
// The view keeps the most connected functions, favouring calls that cross files and
// components.

const MAX_NODES = 120;

export const callsExtractor: ViewExtractor = {
  view: 'calls',
  applies: (paths) => paths.some((p) => SOURCE.test(p) && !p.endsWith('.d.ts')),

  async extract(context) {
    const graph = await buildCallGraph(context.repoDir, context.paths);

    // One edge per (caller, callee); a call outranks a render or a use. Constants that
    // only hold functions aren't drawn.
    const rank = { '': 2, renders: 1, uses: 0 } as const;
    const edges = new Map<string, ViewEdge>();
    const decls = new Map<string, Decl>();
    for (const { from, to, label } of graph.refs) {
      if (from.kind === 'value' || to.kind === 'value') continue;
      const key = `${from.id}->${to.id}`;
      const existing = edges.get(key);
      if (existing && rank[existing.label as keyof typeof rank] >= rank[label])
        continue;
      edges.set(key, { from: from.id, to: to.id, label });
      decls.set(from.id, from);
      decls.set(to.id, to);
    }

    // Keep the functions with the most significant connections.
    const locate = componentLocator(context.components);
    const componentOf = new Map(
      [...decls.values()].map((d) => [d.id, locate(d.file)]),
    );
    const score = new Map<string, number>();
    for (const { from, to } of edges.values()) {
      const a = decls.get(from)!;
      const b = decls.get(to)!;
      const weight =
        componentOf.get(from) !== componentOf.get(to)
          ? 3
          : a.file !== b.file
            ? 2
            : 1;
      score.set(from, (score.get(from) ?? 0) + weight);
      score.set(to, (score.get(to) ?? 0) + weight);
    }
    const kept = new Set(
      [...score]
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_NODES)
        .map(([id]) => id),
    );

    const names = new Map(context.components.map((c) => [c.id, c.name]));
    const nodes: ViewNode[] = [...kept].map((id) => {
      const d = decls.get(id)!;
      const componentId = componentOf.get(id);
      return {
        id,
        name: d.kind === 'component' ? `<${d.key}>` : `${d.key}()`,
        kind: d.kind,
        detail: `${d.file}:${d.line}`,
        group: (componentId && names.get(componentId)) || d.file.split('/')[0]!,
        path: d.file,
        ...(componentId && { componentId }),
      };
    });
    return {
      nodes,
      edges: [...edges.values()].filter(
        (e) => kept.has(e.from) && kept.has(e.to),
      ),
    } satisfies ViewGraph;
  },
};
