import { componentFinder } from '../shared.js';
import type {
  ViewEdge,
  ViewExtractor,
  ViewGraph,
  ViewNode,
} from '../view-graph.js';
import { cloudflare } from './cloudflare.js';
import { cloudFormation } from './cloudformation.js';
import { compose, dockerfiles } from './containers.js';
import { kubernetes } from './kubernetes.js';
import type { Category, Link, Resource } from './model.js';
import { terraform } from './terraform.js';

// The deployed system: what runs, what fronts it, and what it stores data in, read from
// infrastructure-as-code. No model call: every format here declares its resources.
// (CDK and Pulumi describe infrastructure in code, which needs a model; not covered yet.)

const SOURCES = [
  terraform,
  cloudFormation,
  compose,
  dockerfiles,
  kubernetes,
  cloudflare,
];

const APPLIES =
  /\.tf$|(^|\/)((docker-)?compose[^/]*\.ya?ml|Dockerfile[^/]*|[^/]+\.dockerfile|wrangler\.(toml|jsonc?)|serverless\.ya?ml)$|\.(ya?ml|template)$/i;

// Columns of the view, left to right, as the frontend draws them.
export const LAYERS: Record<Exclude<Category, 'glue'>, string> = {
  network: 'Network',
  compute: 'Compute',
  image: 'Compute',
  data: 'Data & messaging',
  messaging: 'Data & messaging',
  security: 'Security & other',
  other: 'Security & other',
};
const RANK: Record<string, number> = {
  Network: 0,
  Compute: 1,
  'Data & messaging': 2,
  'Security & other': 3,
};

const MAX_NODES = 150;
// Glue shared by more resources than this (a VPC's security group, a shared role) would
// connect everything to everything, so it isn't bridged.
const MAX_GLUE_DEGREE = 4;
const MAX_GLUE_HOPS = 3;

// What a chain of glue means, judged by the glue it passes through.
const bridgeLabel = (types: string[]) => {
  const joined = types.join(' ').toLowerCase();
  if (/iam|role|policy/.test(joined)) return 'access';
  if (/integration|method|route|listener|target|url/.test(joined))
    return 'routes to';
  if (/subscription|event|rule|permission|mapping/.test(joined))
    return 'triggers';
  return 'linked';
};

// Connects drawn resources that only meet through glue: a Lambda and the table its role's
// policy grants, a load balancer and the service behind its target group.
function bridge(resources: Resource[], links: Link[]): Link[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const neighbours = new Map<string, Set<string>>();
  for (const { from, to } of links) {
    if (!byId.has(from) || !byId.has(to)) continue;
    if (!neighbours.has(from)) neighbours.set(from, new Set());
    if (!neighbours.has(to)) neighbours.set(to, new Set());
    neighbours.get(from)!.add(to);
    neighbours.get(to)!.add(from);
  }
  const isGlue = (id: string) => byId.get(id)?.category === 'glue';
  const bridgeable = (id: string) =>
    isGlue(id) && (neighbours.get(id)?.size ?? 0) <= MAX_GLUE_DEGREE;

  const bridged: Link[] = [];
  for (const start of resources.filter((r) => r.category !== 'glue')) {
    // Breadth-first through glue only, remembering the glue types on the way.
    const queue: { id: string; via: string[] }[] = [
      ...(neighbours.get(start.id) ?? []),
    ]
      .filter(bridgeable)
      .map((id) => ({ id, via: [byId.get(id)!.type] }));
    const visited = new Set([start.id, ...queue.map((q) => q.id)]);
    while (queue.length) {
      const { id, via } = queue.shift()!;
      for (const next of neighbours.get(id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        if (!isGlue(next)) {
          bridged.push({ from: start.id, to: next, label: bridgeLabel(via) });
        } else if (bridgeable(next) && via.length < MAX_GLUE_HOPS) {
          queue.push({ id: next, via: [...via, byId.get(next)!.type] });
        }
      }
    }
  }
  return bridged;
}

const layerOf = (r: Resource) =>
  LAYERS[r.category as Exclude<Category, 'glue'>];

export const infrastructureExtractor: ViewExtractor = {
  view: 'infrastructure',
  applies: (paths) =>
    paths.some((p) => APPLIES.test(p) && !p.startsWith('.github/')),

  async extract(context) {
    const sourceContext = {
      repoDir: context.repoDir,
      paths: context.paths,
      findComponent: componentFinder(context.components),
    };
    const resources: Resource[] = [];
    const links: Link[] = [];
    for (const source of SOURCES) {
      const collected = await source(sourceContext);
      resources.push(...collected.resources);
      links.push(...collected.links);
    }
    const unique = [...new Map(resources.map((r) => [r.id, r])).values()];
    let drawn = unique.filter((r) => r.category !== 'glue');

    const byId = new Map(drawn.map((r) => [r.id, r]));
    // Direct links between drawn resources, then glue-bridged ones; one edge per pair.
    const pairs = new Set<string>();
    const edges: ViewEdge[] = [];
    const direct = links.map((link) => ({ link, bridged: false }));
    const bridged = bridge(unique, links).map((link) => ({
      link,
      bridged: true,
    }));
    for (const { link, bridged: isBridged } of [...direct, ...bridged]) {
      const a = byId.get(link.from);
      const b = byId.get(link.to);
      if (!a || !b || a === b) continue;
      const key = [a.id, b.id].sort().join('|');
      if (pairs.has(key)) continue;
      pairs.add(key);
      // A bridge has no direction of its own: it points from the front of the system
      // towards its data, except triggers, which come from the queue or topic.
      let forward = true;
      if (isBridged) {
        const towardsData = RANK[layerOf(a)]! <= RANK[layerOf(b)]!;
        forward = link.label === 'triggers' ? !towardsData : towardsData;
      }
      edges.push(forward ? link : { ...link, from: link.to, to: link.from });
    }

    // Past the cap, drop "other" resources first, then the least connected.
    if (drawn.length > MAX_NODES) {
      const degree = (id: string) =>
        edges.filter((e) => e.from === id || e.to === id).length;
      drawn = [...drawn]
        .sort(
          (a, b) =>
            Number(a.category === 'other') - Number(b.category === 'other') ||
            degree(b.id) - degree(a.id),
        )
        .slice(0, MAX_NODES);
    }
    const kept = new Set(drawn.map((r) => r.id));

    const nodes: ViewNode[] = drawn.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.category,
      detail: r.detail,
      group: layerOf(r),
      path: r.path,
      ...(r.componentId && { componentId: r.componentId }),
    }));
    return {
      nodes,
      edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    } satisfies ViewGraph;
  },
};
