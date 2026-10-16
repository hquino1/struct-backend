import { componentLocator } from '../../repo-digest.js';
import { findCalls, type Call } from '../api/calls.js';
import { matchCalls, routeId } from '../api/match.js';
import { findRoutes, type Route } from '../api/routes.js';
import {
  buildCallGraph,
  type CallGraph,
  type RefLabel,
  type Trigger,
} from '../calls/graph.js';
import type {
  ViewEdge,
  ViewExtractor,
  ViewGraph,
  ViewNode,
} from '../view-graph.js';
import { findScreens, type Root, type Screen } from './find.js';

// Which screens call which endpoints, and whether they do it as the screen loads or when the
// user acts. Each screen's code is followed through the call graph (components it renders,
// hooks and functions it calls) to the HTTP calls it can reach, which are matched to the
// server's routes the way the API view matches them.

const APPLIES = /\.[cm]?[jt]sx?$/;
const MAX_SCREENS = 120;
const MAX_DEPTH = 14;
const MAX_UNMATCHED = 30;
// An endpoint nearly every page calls (the current user, feature flags) is drawn once, from
// a shared node, rather than from every page.
const SHARED_SHARE = 0.8;
const MIN_PAGES_FOR_SHARED = 4;

const SHARED_ID = 'screen:*';
const MISSING_GROUP = 'Not found on server';
const EXTERNAL_GROUP = 'External APIs';

// How a path through the code reaches a call: still running as the screen renders, behind
// a load hook or a user action, or passed somewhere that doesn't say when it runs.
type Reach = 'render' | 'unknown' | Trigger;
export type Timing = Trigger | 'unknown';

const step = (reach: Reach, trigger: Trigger | undefined, label: RefLabel) =>
  reach === 'load' || reach === 'action'
    ? reach
    : (trigger ?? (label === 'uses' ? 'unknown' : reach));
const timingOf = (reach: Reach): Timing =>
  reach === 'render' ? 'load' : reach;

// The HTTP calls a screen's code can reach, with when each one runs.
export function reachedCalls(
  roots: Root[],
  graph: CallGraph,
  callsByFile: Map<string, Call[]>,
) {
  const found = new Map<Call, Set<Timing>>();
  const seen = new Set<string>();
  const queue: {
    file: string;
    start: number;
    end: number;
    reach: Reach;
    depth: number;
  }[] = roots.map((r) =>
    r.kind === 'decl'
      ? {
          file: r.decl.file,
          start: r.decl.start,
          end: r.decl.end,
          reach: 'render',
          depth: 0,
        }
      : { ...r, reach: 'render', depth: 0 },
  );
  for (const r of roots) {
    if (r.kind === 'decl') seen.add(`${r.decl.id}|render`);
  }
  while (queue.length) {
    const { file, start, end, reach, depth } = queue.shift()!;
    for (const call of callsByFile.get(file) ?? []) {
      if (call.offset < start || call.offset >= end) continue;
      const timing = timingOf(
        step(reach, graph.triggerAt(file, call.offset), ''),
      );
      found.set(call, (found.get(call) ?? new Set()).add(timing));
    }
    if (depth >= MAX_DEPTH) continue;
    for (const ref of graph.refsIn(file, start, end)) {
      const next = step(reach, ref.trigger, ref.label);
      const key = `${ref.to.id}|${next}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({
        file: ref.to.file,
        start: ref.to.start,
        end: ref.to.end,
        reach: next,
        depth: depth + 1,
      });
    }
  }
  return found;
}

export const timingLabel = (timings: Set<Timing>) =>
  [timings.has('load') && 'on load', timings.has('action') && 'on action']
    .filter(Boolean)
    .join(' · ');

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export const screensExtractor: ViewExtractor = {
  view: 'screens',
  applies: (paths) =>
    paths.some((p) => APPLIES.test(p) && !p.endsWith('.d.ts')),

  async extract(context) {
    const graph = await buildCallGraph(context.repoDir, context.paths);
    const screens = findScreens(context.paths, graph)
      .sort(
        (a, b) =>
          a.route.localeCompare(b.route) ||
          a.kind.localeCompare(b.kind) ||
          a.file.localeCompare(b.file),
      )
      .slice(0, MAX_SCREENS);
    if (!screens.length) return { nodes: [], edges: [] };

    const { routes, texts } = await findRoutes(context.repoDir, context.paths);
    const calls = findCalls(texts, new Set(routes.map((r) => r.file)));
    const callsByFile = new Map<string, Call[]>();
    for (const call of calls) {
      callsByFile.set(call.file, [...(callsByFile.get(call.file) ?? []), call]);
    }

    const reached = screens.map((s) =>
      reachedCalls(s.roots, graph, callsByFile),
    );
    const used = [...new Set(reached.flatMap((r) => [...r.keys()]))];
    const matched = await matchCalls(context.llm, used, routes);

    const locate = componentLocator(context.components);
    const componentName = new Map(
      context.components.map((c) => [c.id, c.name]),
    );
    const nameOf = (file: string) => {
      const id = locate(file);
      return id && componentName.get(id);
    };
    // One band of screens per app when the repository has several.
    const apps = new Set(screens.map((s) => locate(s.file) ?? ''));
    const screenGroup = (s: Screen) =>
      apps.size > 1 ? `${nameOf(s.file) ?? 'App'} screens` : 'Screens';

    // What each screen's calls reach: an endpoint here, a path no route serves, or another
    // host. Keyed by target node, with how it's reached.
    interface Target {
      node: ViewNode;
      timings: Set<Timing>;
      byModel: boolean;
      sites: number;
    }
    const targetNodes = new Map<string, ViewNode>();
    const endpointRoutes = new Map<string, Route>();
    let unmatchedCount = 0;
    const targetOf = (call: Call): ViewNode | undefined => {
      const match = matched.get(call);
      if (match) {
        const id = routeId(match.route);
        endpointRoutes.set(id, match.route);
        if (!targetNodes.has(id)) {
          const componentId = locate(match.route.file);
          targetNodes.set(id, {
            id,
            name: `${match.route.method} ${match.route.path}`,
            kind: 'endpoint',
            detail: '',
            group: nameOf(match.route.file) ?? 'Server',
            path: match.route.file,
            ...(componentId && { componentId }),
          });
        }
        return targetNodes.get(id);
      }
      const external = !!call.host || !routes.length;
      const id = external
        ? `remote:${call.host ?? 'elsewhere'}`
        : `missing:${call.method ?? 'ANY'} ${call.path}`;
      if (!targetNodes.has(id)) {
        if (unmatchedCount >= MAX_UNMATCHED) return undefined;
        unmatchedCount++;
        targetNodes.set(id, {
          id,
          name: external
            ? (call.host ?? 'Outside this repository')
            : `${call.method ?? 'ANY'} ${call.path}`,
          kind: external ? 'remote' : 'missing',
          detail: external ? '' : 'No matching route found in this repository',
          group: external ? EXTERNAL_GROUP : MISSING_GROUP,
          path: call.file,
        });
      }
      return targetNodes.get(id);
    };

    const screenTargets = screens.map((_, i) => {
      const targets = new Map<string, Target>();
      for (const [call, timings] of reached[i]!) {
        const node = targetOf(call);
        if (!node) continue;
        const t = targets.get(node.id) ?? {
          node,
          timings: new Set(),
          byModel: false,
          sites: 0,
        };
        timings.forEach((x) => t.timings.add(x));
        t.byModel ||= !!matched.get(call)?.byModel;
        t.sites++;
        targets.set(node.id, t);
      }
      return targets;
    });

    // Endpoints nearly every page calls move to the shared node.
    const pages = screens.flatMap((s, i) => (s.kind === 'page' ? [i] : []));
    const shared = new Map<string, Target>();
    if (pages.length >= MIN_PAGES_FOR_SHARED) {
      const counts = new Map<string, number>();
      for (const i of pages) {
        for (const id of screenTargets[i]!.keys())
          counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const [id, n] of counts) {
        if (n < pages.length * SHARED_SHARE) continue;
        for (const i of pages) {
          const t = screenTargets[i]!.get(id);
          if (!t) continue;
          const s = shared.get(id) ?? {
            ...t,
            timings: new Set<Timing>(),
            sites: 0,
          };
          t.timings.forEach((x) => s.timings.add(x));
          s.byModel ||= t.byModel;
          s.sites += t.sites;
          shared.set(id, s);
          screenTargets[i]!.delete(id);
        }
      }
    }

    const edges: ViewEdge[] = [];
    const callers = new Map<string, Set<string>>();
    const link = (from: string, t: Target) => {
      edges.push({
        from,
        to: t.node.id,
        label: [timingLabel(t.timings), t.byModel && 'matched by AI']
          .filter(Boolean)
          .join(' · '),
      });
      callers.set(t.node.id, (callers.get(t.node.id) ?? new Set()).add(from));
    };

    const screenNodes: ViewNode[] = screens.map((s, i) => {
      const id = `screen:${s.file}#${s.route}#${i}`;
      const targets = [...screenTargets[i]!.values()];
      targets.forEach((t) => link(id, t));
      const onLoad = targets.filter((t) => t.timings.has('load')).length;
      const onAction = targets.filter((t) => t.timings.has('action')).length;
      const componentId = locate(s.file);
      const root = s.roots.find((r) => r.kind === 'decl');
      return {
        id,
        name: s.name ?? (s.kind === 'layout' ? `${s.route} layout` : s.route),
        kind: s.kind,
        detail: [
          root?.kind === 'decl' && `<${root.decl.key}>`,
          targets.length
            ? [
                onLoad && `${onLoad} on load`,
                onAction && `${onAction} on action`,
              ]
                .filter(Boolean)
                .join(', ') || plural(targets.length, 'call')
            : 'no API calls found',
        ]
          .filter(Boolean)
          .join(' · '),
        group: screenGroup(s),
        path: s.file,
        ...(componentId && { componentId }),
      };
    });

    const sharedNodes: ViewNode[] = shared.size
      ? [
          {
            id: SHARED_ID,
            name: 'Every page',
            kind: 'shared',
            detail: `Calls ${plural(shared.size, 'endpoint')} from nearly every page, usually through a shared layout or hook`,
            group: screenNodes[0]!.group,
          },
        ]
      : [];
    for (const t of shared.values()) link(SHARED_ID, t);

    const targets = [...targetNodes.values()]
      .filter((n) => callers.has(n.id))
      .map((n): ViewNode => {
        const by = callers.get(n.id)!;
        const screensCount = [...by].filter((id) => id !== SHARED_ID).length;
        const usedBy = by.has(SHARED_ID)
          ? 'used by nearly every page'
          : `used by ${plural(screensCount, 'screen')}`;
        if (n.kind === 'endpoint') {
          const r = endpointRoutes.get(n.id)!;
          return {
            ...n,
            detail: [r.framework, r.handler && `${r.handler}()`, usedBy]
              .filter(Boolean)
              .join(' · '),
          };
        }
        return { ...n, detail: [n.detail, usedBy].filter(Boolean).join(' · ') };
      })
      // Endpoints first, grouped by server; then what isn't served here.
      .sort((a, b) => {
        const order = (n: ViewNode) =>
          n.kind === 'endpoint' ? 0 : n.kind === 'remote' ? 1 : 2;
        return (
          order(a) - order(b) ||
          a.group.localeCompare(b.group) ||
          a.name.localeCompare(b.name)
        );
      });

    return {
      nodes: [...screenNodes, ...sharedNodes, ...targets],
      edges,
    } satisfies ViewGraph;
  },
};
