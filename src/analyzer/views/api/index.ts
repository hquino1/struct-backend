import { z } from 'zod';
import { API_MATCH_SYSTEM } from '../../prompts.js';
import { componentLocator } from '../../repo-digest.js';
import type {
  ViewContext,
  ViewEdge,
  ViewExtractor,
  ViewGraph,
  ViewNode,
} from '../view-graph.js';
import { findCalls, type Call } from './calls.js';
import { findRoutes, type Route } from './routes.js';

// Which code calls which HTTP endpoints. Routes and calls are found by pattern and matched
// by path; the model only matches the calls whose paths don't line up (a router mounted
// under a prefix elsewhere, a base path built at runtime).

const APPLIES =
  /\.([cm]?[jt]sx?|py|java|kt|go)$|(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i;
const MAX_ENDPOINTS = 150;
const MAX_MODEL_CALLS = 60;
const MAX_MODEL_ROUTES = 300;
const MAX_UNMATCHED = 30;

export const CALLERS_GROUP = 'Callers';
const MISSING_GROUP = 'Not found on server';
const EXTERNAL_GROUP = 'External APIs';

const segments = (path: string) => path.split('/').filter(Boolean);
const isParam = (segment: string) => segment.startsWith(':');

// How well a call's path fits a route: 3 for the same shape, 2 when the call adds a prefix
// the route doesn't declare (`/api` from a proxy), 1 when the route has a prefix the call's
// base URL carries. Ties go to the fit with more literal segments in common.
function fit(call: Call, route: Route) {
  if (call.method && route.method !== 'ALL' && call.method !== route.method)
    return 0;
  const c = segments(call.path);
  const r = segments(route.path);
  const align = (a: string[], b: string[]) => {
    let literal = 0;
    for (let i = 0; i < a.length; i++) {
      if (isParam(a[i]!) || isParam(b[i]!)) continue;
      if (a[i] !== b[i]) return -1;
      literal++;
    }
    return literal;
  };
  if (c.length === r.length) {
    const literal = align(c, r);
    return literal < 0 ? 0 : 3 + literal / 100;
  }
  if (c.length > r.length && r.length >= 1) {
    const literal = align(c.slice(c.length - r.length), r);
    return literal < 1 ? 0 : 2 + literal / 100;
  }
  if (r.length > c.length && c.length >= 2) {
    const literal = align(c, r.slice(r.length - c.length));
    return literal < 1 ? 0 : 1 + literal / 100;
  }
  return 0;
}

const bestRoute = (call: Call, routes: Route[]) => {
  let best: { route: Route; score: number } | undefined;
  for (const route of routes) {
    const score = fit(call, route);
    if (score > (best?.score ?? 0)) best = { route, score };
  }
  return best?.route;
};

const MatchResult = z.object({
  matches: z
    .array(
      z.object({
        call: z.number().int().describe('Index of the call.'),
        route: z.number().int().describe('Index of the route it reaches.'),
      }),
    )
    .describe('Only calls you are confident reach one of the listed routes.'),
});

async function matchWithModel(
  llm: ViewContext['llm'],
  calls: Call[],
  routes: Route[],
) {
  const shown = calls.slice(0, MAX_MODEL_CALLS);
  const listed = routes.slice(0, MAX_MODEL_ROUTES);
  const prompt = [
    '<routes>',
    ...listed.map((r, i) => `${i}: ${r.method} ${r.path} (${r.file})`),
    '</routes>',
    '<calls>',
    ...shown.map(
      (c, i) =>
        `${i}: ${c.method ?? '?'} ${c.path} (${c.file}:${c.line})\n${c.snippet}`,
    ),
    '</calls>',
  ].join('\n');
  const { matches } = await llm.callTool({
    system: API_MATCH_SYSTEM,
    prompt,
    tool: {
      name: 'record_matches',
      description: 'Record which calls reach which routes.',
      schema: MatchResult,
    },
    effort: 'low',
  });
  const found = new Map<Call, Route>();
  for (const { call, route } of matches) {
    if (shown[call] && listed[route]) found.set(shown[call], listed[route]);
  }
  return found;
}

export const apiExtractor: ViewExtractor = {
  view: 'api',
  applies: (paths) => paths.some((p) => APPLIES.test(p)),

  async extract(context) {
    const { routes, texts } = await findRoutes(context.repoDir, context.paths);
    const serverFiles = new Set(routes.map((r) => r.file));
    const calls = findCalls(texts, serverFiles);
    if (!routes.length && !calls.length) return { nodes: [], edges: [] };

    const internal = calls.filter((c) => !c.host);
    const matched = new Map<Call, { route: Route; byModel: boolean }>();
    for (const call of internal) {
      const route = bestRoute(call, routes);
      if (route) matched.set(call, { route, byModel: false });
    }
    const unmatched = internal.filter((c) => !matched.has(c));
    if (unmatched.length && routes.length) {
      for (const [call, route] of await matchWithModel(
        context.llm,
        unmatched,
        routes,
      )) {
        matched.set(call, { route, byModel: true });
      }
    }

    const locate = componentLocator(context.components);
    const componentName = new Map(
      context.components.map((c) => [c.id, c.name]),
    );
    const routeId = (r: Route) => `route:${r.method} ${r.path}@${r.file}`;
    const serverGroup = (file: string) => {
      const id = locate(file);
      return (id && componentName.get(id)) ?? 'Server';
    };

    // Endpoints that are called first, so the cap drops unused ones.
    const callers = new Map<string, number>();
    for (const { route } of matched.values()) {
      callers.set(routeId(route), (callers.get(routeId(route)) ?? 0) + 1);
    }
    const endpoints = [...new Map(routes.map((r) => [routeId(r), r])).values()]
      .sort(
        (a, b) =>
          (callers.get(routeId(b)) ?? 0) - (callers.get(routeId(a)) ?? 0),
      )
      .slice(0, MAX_ENDPOINTS);

    const callerNodes = new Map<string, ViewNode & { calls: Set<Call> }>();
    const callerOf = (call: Call) => {
      const componentId = locate(call.file);
      const key = componentId ?? call.file;
      let node = callerNodes.get(key);
      if (!node) {
        node = {
          id: `caller:${key}`,
          name: (componentId && componentName.get(componentId)) ?? call.file,
          kind: 'client',
          detail: '',
          group: CALLERS_GROUP,
          path: call.file,
          ...(componentId && { componentId }),
          calls: new Set(),
        };
        callerNodes.set(key, node);
      }
      node.calls.add(call);
      return node;
    };

    const edgeCounts = new Map<
      string,
      ViewEdge & { count: number; byModel: number }
    >();
    const link = (from: string, to: string, byModel: boolean) => {
      const key = `${from}->${to}`;
      const edge = edgeCounts.get(key) ?? {
        from,
        to,
        label: '',
        count: 0,
        byModel: 0,
      };
      edge.count++;
      if (byModel) edge.byModel++;
      edgeCounts.set(key, edge);
    };

    const kept = new Set(endpoints.map(routeId));
    const extraNodes = new Map<string, ViewNode>();
    for (const call of calls) {
      const match = matched.get(call);
      if (match && kept.has(routeId(match.route))) {
        link(callerOf(call).id, routeId(match.route), match.byModel);
        continue;
      }
      if (match) continue; // reaches an endpoint past the cap
      // Calls to other hosts, or to paths no route here serves.
      const external = !!call.host || !routes.length;
      const id = `${external ? 'remote' : 'missing'}:${call.method ?? 'ANY'} ${call.host ?? ''}${call.path}`;
      if (!extraNodes.has(id)) {
        if ([...extraNodes.values()].length >= MAX_UNMATCHED) continue;
        extraNodes.set(id, {
          id,
          name: `${call.method ?? 'ANY'} ${call.path}`,
          kind: external ? 'remote' : 'missing',
          detail: external
            ? call.host
              ? `On ${call.host}`
              : 'Served outside this repository'
            : 'No matching route found in this repository',
          group: external ? EXTERNAL_GROUP : MISSING_GROUP,
          path: call.file,
        });
      }
      link(callerOf(call).id, id, false);
    }

    const nodes: ViewNode[] = [
      ...[...callerNodes.values()].map(({ calls: own, ...node }) => {
        const targets = new Set(
          [...edgeCounts.values()]
            .filter((e) => e.from === node.id)
            .map((e) => e.to),
        );
        return {
          ...node,
          detail: `${own.size} ${own.size === 1 ? 'call' : 'calls'} to ${targets.size} ${targets.size === 1 ? 'endpoint' : 'endpoints'}`,
        };
      }),
      ...endpoints.map((r): ViewNode => {
        const componentId = locate(r.file);
        const count = callers.get(routeId(r)) ?? 0;
        return {
          id: routeId(r),
          name: `${r.method} ${r.path}`,
          kind: 'endpoint',
          detail: [
            r.framework,
            r.handler && `${r.handler}()`,
            count
              ? `${count} ${count === 1 ? 'call site' : 'call sites'}`
              : 'no callers found',
          ]
            .filter(Boolean)
            .join(' · '),
          group: serverGroup(r.file),
          path: r.file,
          ...(componentId && { componentId }),
        };
      }),
      ...extraNodes.values(),
    ];
    // "×3" for repeated call sites; say which links rest on the model's matching.
    const edges = [...edgeCounts.values()].map(
      ({ count, byModel, ...edge }): ViewEdge => ({
        ...edge,
        label: [
          count > 1 && `×${count}`,
          byModel === count
            ? 'matched by AI'
            : byModel > 0 && `${byModel} matched by AI`,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    );
    return { nodes, edges } satisfies ViewGraph;
  },
};
