import { z } from 'zod';
import { API_MATCH_SYSTEM } from '../../prompts.js';
import type { ViewContext } from '../view-graph.js';
import type { Call } from './calls.js';
import type { Route } from './routes.js';

// Which route each HTTP call reaches. Calls are matched by path; the model only matches the
// calls whose paths don't line up (a router mounted under a prefix elsewhere, a base path
// built at runtime). Shared by the API and screens views.

const MAX_MODEL_CALLS = 60;
const MAX_MODEL_ROUTES = 300;

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

export interface Match {
  route: Route;
  byModel: boolean;
}

// The route each call to this repository's own server reaches, where one can be found.
// Calls to other hosts are left out.
export async function matchCalls(
  llm: ViewContext['llm'],
  calls: Call[],
  routes: Route[],
) {
  const matched = new Map<Call, Match>();
  const internal = calls.filter((c) => !c.host);
  for (const call of internal) {
    const route = bestRoute(call, routes);
    if (route) matched.set(call, { route, byModel: false });
  }
  const unmatched = internal.filter((c) => !matched.has(c));
  if (unmatched.length && routes.length) {
    for (const [call, route] of await matchWithModel(llm, unmatched, routes)) {
      matched.set(call, { route, byModel: true });
    }
  }
  return matched;
}

export const routeId = (r: Route) => `route:${r.method} ${r.path}@${r.file}`;
