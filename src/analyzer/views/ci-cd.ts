import {
  basename,
  componentFinder,
  isRecord,
  readYaml,
  strings,
  text,
  withComponent,
  type ComponentFinder,
  type YamlMap,
} from './shared.js';
import type {
  ViewEdge,
  ViewExtractor,
  ViewGraph,
  ViewNode,
} from './view-graph.js';

// CI/CD pipelines as a graph of triggers and jobs, read straight from the workflow files:
// GitHub Actions (`needs`, reusable workflows, `workflow_run`) and GitLab CI (stages, `needs`).

const GITHUB_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const GITLAB_CI = '.gitlab-ci.yml';
// Keeps a monorepo with hundreds of jobs readable and well inside the item size limit.
const MAX_NODES = 150;

const DEPLOY = /deploy|release|publish|rollout|promote/i;

const jobKind = (name: string, config: YamlMap) =>
  config['environment'] !== undefined || DEPLOY.test(name) ? 'deploy' : 'job';

interface Workflow {
  path: string;
  name: string;
  triggerId: string;
  on: unknown;
  // Jobs no other job waits for: where the workflow ends.
  sinks: string[];
}

function githubWorkflow(
  path: string,
  doc: YamlMap,
  group: string,
  findComponent: ComponentFinder,
  graph: ViewGraph,
): Workflow {
  const on = doc['on'];
  const triggers = isRecord(on) ? Object.keys(on) : strings(on);
  const triggerId = `${path}#on`;
  const branches = isRecord(on)
    ? [
        ...new Set(
          Object.values(on).flatMap((t) =>
            isRecord(t) ? strings(t['branches']) : [],
          ),
        ),
      ]
    : [];
  graph.nodes.push({
    id: triggerId,
    name: triggers.join(' · ') || 'Manual',
    kind: 'trigger',
    detail: branches.length
      ? `Branches: ${branches.join(', ')}`
      : 'Starts the workflow',
    group,
    path,
    ...withComponent(findComponent('', isRecord(on) ? on : undefined)),
  });

  const jobs = isRecord(doc['jobs']) ? doc['jobs'] : {};
  const ids = new Map(Object.keys(jobs).map((key) => [key, `${path}#${key}`]));
  const needed = new Set<string>();
  for (const [key, config] of Object.entries(jobs)) {
    if (!isRecord(config)) continue;
    const id = ids.get(key)!;
    const name = text(config['name']) ?? key;
    const uses = text(config['uses']);
    const runner = strings(config['runs-on']).join(', ') || 'custom runner';
    const steps = Array.isArray(config['steps']) ? config['steps'].length : 0;
    graph.nodes.push({
      id,
      name,
      kind: uses ? 'workflow' : jobKind(`${key} ${name}`, config),
      detail: uses
        ? `Uses ${uses}`
        : `${runner} · ${steps} ${steps === 1 ? 'step' : 'steps'}`,
      group,
      path,
      ...withComponent(findComponent('', config, doc['defaults'])),
    });
    const needs = strings(config['needs']).filter((n) => ids.has(n));
    needs.forEach((n) => needed.add(n));
    if (needs.length) {
      needs.forEach((n) =>
        graph.edges.push({ from: ids.get(n)!, to: id, label: 'needs' }),
      );
    } else {
      graph.edges.push({ from: triggerId, to: id, label: '' });
    }
  }
  return {
    path,
    name: text(doc['name']) ?? basename(path),
    triggerId,
    on,
    sinks: [...ids].filter(([key]) => !needed.has(key)).map(([, id]) => id),
  };
}

function githubLinks(workflows: Workflow[], graph: ViewGraph) {
  const byPath = new Map(workflows.map((w) => [w.path, w]));
  const byName = new Map(workflows.map((w) => [w.name, w]));
  // A job calling a reusable workflow in this repo starts that workflow.
  for (const node of graph.nodes) {
    const local = /^Uses \.\/(\.github\/workflows\/[^@\s]+)/.exec(node.detail);
    const target = local && byPath.get(local[1]!);
    if (target)
      graph.edges.push({ from: node.id, to: target.triggerId, label: 'calls' });
  }
  // `on: workflow_run` starts a workflow when another one finishes.
  for (const w of workflows) {
    const run = isRecord(w.on) ? w.on['workflow_run'] : undefined;
    for (const name of isRecord(run) ? strings(run['workflows']) : []) {
      for (const sink of byName.get(name)?.sinks ?? []) {
        graph.edges.push({
          from: sink,
          to: w.triggerId,
          label: 'on completion',
        });
      }
    }
  }
}

const GITLAB_KEYWORDS = new Set([
  'stages',
  'variables',
  'default',
  'include',
  'workflow',
  'image',
  'services',
  'before_script',
  'after_script',
  'cache',
  'pages',
]);

function gitlabPipeline(
  doc: YamlMap,
  findComponent: ComponentFinder,
  graph: ViewGraph,
) {
  const path = GITLAB_CI;
  const group = 'GitLab CI';
  const triggerId = `${path}#on`;
  graph.nodes.push({
    id: triggerId,
    name: 'Pipeline',
    kind: 'trigger',
    detail: 'Starts on push or merge request',
    group,
    path,
  });

  const declared = strings(doc['stages']);
  const stages = [
    '.pre',
    ...(declared.length ? declared : ['build', 'test', 'deploy']),
    '.post',
  ];
  const jobs = Object.entries(doc).filter(
    (entry): entry is [string, YamlMap] =>
      !entry[0].startsWith('.') &&
      !GITLAB_KEYWORDS.has(entry[0]) &&
      isRecord(entry[1]),
  );
  const ids = new Map(jobs.map(([key]) => [key, `${path}#${key}`]));
  const stageOf = (config: YamlMap) => text(config['stage']) ?? 'test';

  for (const [key, config] of jobs) {
    const id = ids.get(key)!;
    const stage = stageOf(config);
    const image = text(
      isRecord(config['image']) ? config['image']['name'] : config['image'],
    );
    graph.nodes.push({
      id,
      name: key,
      kind: config['trigger'] ? 'workflow' : jobKind(`${key} ${stage}`, config),
      detail: [`Stage ${stage}`, image].filter(Boolean).join(' · '),
      group,
      path,
      ...withComponent(findComponent('', config)),
    });

    // Explicit `needs` (even an empty list) replaces the wait for the previous stage.
    let upstream: string[];
    if (config['needs'] !== undefined) {
      upstream = (Array.isArray(config['needs']) ? config['needs'] : [])
        .map((n: unknown) => (isRecord(n) ? text(n['job']) : text(n)))
        .filter((n): n is string => !!n && ids.has(n));
    } else {
      const index = stages.indexOf(stage);
      const earlier = stages
        .slice(0, Math.max(index, 0))
        .reverse()
        .find((s) => jobs.some(([, c]) => stageOf(c) === s));
      upstream = jobs.filter(([, c]) => stageOf(c) === earlier).map(([k]) => k);
    }
    if (upstream.length) {
      upstream.forEach((n) =>
        graph.edges.push({ from: ids.get(n)!, to: id, label: '' }),
      );
    } else {
      graph.edges.push({ from: triggerId, to: id, label: '' });
    }
  }
}

export const ciCdExtractor: ViewExtractor = {
  view: 'ci-cd',
  applies: (paths) =>
    paths.some((p) => GITHUB_WORKFLOW.test(p) || p === GITLAB_CI),

  async extract(context) {
    const graph: ViewGraph = { nodes: [], edges: [] };
    const findComponent = componentFinder(context.components);

    const workflows: Workflow[] = [];
    const groups = new Set<string>();
    for (const path of context.paths.filter((p) => GITHUB_WORKFLOW.test(p))) {
      const doc = await readYaml(context.repoDir, path);
      if (!doc) continue;
      // Workflows can share a display name; the band label must stay unique.
      let group = text(doc['name']) ?? basename(path);
      if (groups.has(group)) group = `${group} (${basename(path)})`;
      groups.add(group);
      workflows.push(githubWorkflow(path, doc, group, findComponent, graph));
    }
    githubLinks(workflows, graph);

    if (context.paths.includes(GITLAB_CI)) {
      const doc = await readYaml(context.repoDir, GITLAB_CI);
      if (doc) gitlabPipeline(doc, findComponent, graph);
    }

    return capped(graph);
  },
};

// Drops nodes past the cap, and with them any edge that loses an end or repeats.
function capped({ nodes, edges }: ViewGraph): ViewGraph {
  const kept: ViewNode[] = nodes.slice(0, MAX_NODES);
  const ids = new Set(kept.map((n) => n.id));
  const seen = new Set<string>();
  const keptEdges: ViewEdge[] = edges.filter((e) => {
    const key = `${e.from}->${e.to}`;
    const keep =
      ids.has(e.from) && ids.has(e.to) && e.from !== e.to && !seen.has(key);
    seen.add(key);
    return keep;
  });
  return { nodes: kept, edges: keptEdges };
}
