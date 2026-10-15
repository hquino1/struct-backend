import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readText } from '../repo-digest.js';
import type {
  ViewContext,
  ViewEdge,
  ViewExtractor,
  ViewGraph,
  ViewNode,
} from './view-graph.js';

// Which packages each component uses and which components import each other. Imports come
// from the trace step's scan of the code (JS/TS and Python); versions and, for languages
// the scan doesn't read (Go, Rust), the packages themselves come from manifests.

type Ecosystem = 'npm' | 'PyPI' | 'Go' | 'Cargo';

const MANIFESTS: [RegExp, Ecosystem][] = [
  [/(^|\/)package\.json$/, 'npm'],
  [/(^|\/)requirements[^/]*\.txt$/, 'PyPI'],
  [/(^|\/)pyproject\.toml$/, 'PyPI'],
  [/(^|\/)go\.mod$/, 'Go'],
  [/(^|\/)Cargo\.toml$/, 'Cargo'],
];
// Ecosystems whose imports the code scan doesn't read: their manifest is the evidence.
const DECLARED_ONLY = new Set<Ecosystem>(['Go', 'Cargo']);
const SCANNED_SOURCE = /\.([cm]?[jt]sx?|py)$/;

const MAX_FILE_BYTES = 512_000;
// Past these, the rest fold into one "N more" node per component.
const MAX_PACKAGES_PER_COMPONENT = 15;
const MAX_PACKAGE_NODES = 120;

export const COMPONENTS_GROUP = 'Components';
export const PACKAGES_GROUP = 'Packages';

interface Declared {
  name: string;
  version: string;
  dev: boolean;
  ecosystem: Ecosystem;
  manifest: string;
}

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Package names compare loosely: PyPI and Cargo treat `-`, `_`, and `.` alike.
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

const ecosystemOf = (path: string) =>
  MANIFESTS.find(([pattern]) => pattern.test(path))?.[1];

// `name[extra]>=1.2; python_version < "3.12"` → name and version spec.
function requirement(line: string) {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;#]*)/.exec(
    line.trim(),
  );
  return m ? { name: m[1]!, version: m[2]!.trim() } : undefined;
}

const tableEntries = (table: unknown) =>
  isTable(table)
    ? Object.entries(table).map(([name, spec]) => ({
        name,
        version:
          typeof spec === 'string'
            ? spec
            : isTable(spec) && typeof spec['version'] === 'string'
              ? spec['version']
              : '',
      }))
    : [];

function parseManifest(
  path: string,
  text: string,
): Omit<Declared, 'manifest' | 'ecosystem'>[] {
  const file = posix.basename(path);
  if (file === 'package.json') {
    const pkg: unknown = JSON.parse(text);
    if (!isTable(pkg)) return [];
    const group = (key: string, dev: boolean) =>
      tableEntries(pkg[key]).map((d) => ({ ...d, dev }));
    return [
      ...group('dependencies', false),
      ...group('peerDependencies', false),
      ...group('optionalDependencies', false),
      ...group('devDependencies', true),
    ];
  }
  if (file.startsWith('requirements')) {
    const dev = /dev|test|lint|doc/i.test(file);
    return text
      .split('\n')
      .filter((line) => !/^\s*(#|-|$)/.test(line) && !line.includes('://'))
      .flatMap((line) => {
        const r = requirement(line);
        return r ? [{ ...r, dev }] : [];
      });
  }
  if (file === 'pyproject.toml') {
    const doc = parseToml(text) as Table;
    const project = isTable(doc['project']) ? doc['project'] : {};
    const poetry =
      isTable(doc['tool']) && isTable(doc['tool']['poetry'])
        ? doc['tool']['poetry']
        : {};
    const pep508 = (list: unknown, dev: boolean) =>
      (Array.isArray(list) ? list : []).flatMap((line) => {
        const r = typeof line === 'string' ? requirement(line) : undefined;
        return r ? [{ ...r, dev }] : [];
      });
    const groups = isTable(poetry['group'])
      ? Object.values(poetry['group'])
      : [];
    return [
      ...pep508(project['dependencies'], false),
      ...Object.values(
        isTable(project['optional-dependencies'])
          ? project['optional-dependencies']
          : {},
      ).flatMap((list) => pep508(list, true)),
      ...tableEntries(poetry['dependencies'])
        .filter((d) => d.name !== 'python')
        .map((d) => ({ ...d, dev: false })),
      ...tableEntries(poetry['dev-dependencies']).map((d) => ({
        ...d,
        dev: true,
      })),
      ...groups.flatMap((g) =>
        isTable(g)
          ? tableEntries(g['dependencies']).map((d) => ({ ...d, dev: true }))
          : [],
      ),
    ];
  }
  if (file === 'go.mod') {
    // Both `require x v1` and `require ( ... )` blocks; indirect ones aren't chosen by the code.
    const lines: string[] = [];
    let inBlock = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (inBlock) {
        if (line.startsWith(')')) inBlock = false;
        else lines.push(line);
      } else if (/^require\s*\($/.test(line)) inBlock = true;
      else if (line.startsWith('require ')) lines.push(line.slice(8));
    }
    return lines.flatMap((line) => {
      const m = /^(\S+)\s+(v\S+)/.exec(line);
      return m && !line.includes('// indirect')
        ? [{ name: m[1]!, version: m[2]!, dev: false }]
        : [];
    });
  }
  // Cargo.toml
  const doc = parseToml(text) as Table;
  return [
    ...tableEntries(doc['dependencies']).map((d) => ({ ...d, dev: false })),
    ...tableEntries(doc['dev-dependencies']).map((d) => ({ ...d, dev: true })),
    ...tableEntries(doc['build-dependencies']).map((d) => ({
      ...d,
      dev: true,
    })),
  ];
}

async function readManifests({ repoDir, paths }: ViewContext) {
  const declared: Declared[] = [];
  for (const path of paths) {
    const ecosystem = ecosystemOf(path);
    if (!ecosystem) continue;
    const text = await readText(repoDir, path, MAX_FILE_BYTES).catch(
      () => undefined,
    );
    if (!text) continue;
    try {
      for (const d of parseManifest(path, text)) {
        declared.push({ ...d, ecosystem, manifest: path });
      }
    } catch {
      // A malformed manifest only loses its versions.
    }
  }
  return declared;
}

const dirOf = (path: string) => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};
const clean = (path: string) =>
  path.trim().replace(/^\.\//, '').replace(/\/+$/, '');
const within = (path: string, dir: string) =>
  dir === '' || path === dir || path.startsWith(`${dir}/`);

// The manifests that describe a component: any inside its paths, and otherwise the
// nearest one above them (e.g. the root package.json of a single-package repo).
function manifestsFor(componentPaths: string[], declared: Declared[]) {
  const paths = componentPaths.map(clean).filter((p) => p && p !== '.');
  if (!paths.length) return [];
  const manifests = [...new Set(declared.map((d) => d.manifest))];
  const inside = manifests.filter((m) =>
    paths.some((p) => within(dirOf(m), p)),
  );
  const covered = new Set(inside.map(ecosystemOf));
  const above = manifests
    .filter((m) => !covered.has(ecosystemOf(m)))
    .filter((m) => paths.some((p) => within(p, dirOf(m))))
    .sort((a, b) => dirOf(b).length - dirOf(a).length);
  // The nearest one per ecosystem.
  const nearest = [
    ...new Map(above.map((m) => [ecosystemOf(m), m])).values(),
  ].reverse();
  const chosen = new Set([...inside, ...nearest].filter(Boolean));
  return declared.filter((d) => chosen.has(d.manifest));
}

interface Use {
  key: string;
  name: string;
  count: number;
  declared?: Declared;
}

export const dependenciesExtractor: ViewExtractor = {
  view: 'dependencies',
  applies: (paths) =>
    paths.some((p) => ecosystemOf(p) !== undefined || SCANNED_SOURCE.test(p)),

  async extract(context) {
    const { components, facts } = context;
    const declared = await readManifests(context);

    // What each component uses, most used first.
    const uses = new Map<string, Use[]>();
    const notImported = new Map<string, number>();
    const manifestOf = new Map<string, string>();
    for (const c of components) {
      const own = manifestsFor(c.paths, declared);
      const byName = new Map(own.map((d) => [normalize(d.name), d]));
      const imported = facts.get(c.id)?.packages ?? new Map<string, number>();
      const list: Use[] = [...imported].map(([name, count]) => ({
        key: normalize(name),
        name,
        count,
        declared: byName.get(normalize(name)),
      }));
      const importedKeys = new Set(list.map((u) => u.key));
      for (const d of own) {
        if (d.dev || importedKeys.has(normalize(d.name))) continue;
        if (DECLARED_ONLY.has(d.ecosystem)) {
          list.push({
            key: normalize(d.name),
            name: d.name,
            count: 0,
            declared: d,
          });
          importedKeys.add(normalize(d.name));
        } else if (!d.name.startsWith('@types/')) {
          // Runtime dependencies no scanned file imports: used by config or tooling, or unused.
          notImported.set(c.id, (notImported.get(c.id) ?? 0) + 1);
        }
      }
      if (own[0]) manifestOf.set(c.id, own[0].manifest);
      uses.set(
        c.id,
        list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      );
    }

    // Packages shared by many components matter most; keep those when trimming.
    const users = new Map<
      string,
      { use: Use; components: number; count: number }
    >();
    for (const list of uses.values()) {
      for (const use of list.slice(0, MAX_PACKAGES_PER_COMPONENT)) {
        const entry = users.get(use.key);
        if (entry) {
          entry.components++;
          entry.count += use.count;
          entry.use.declared ??= use.declared;
        } else
          users.set(use.key, {
            use: { ...use },
            components: 1,
            count: use.count,
          });
      }
    }
    const kept = new Map(
      [...users]
        .sort(
          ([, a], [, b]) => b.components - a.components || b.count - a.count,
        )
        .slice(0, MAX_PACKAGE_NODES),
    );

    // Components first, then packages, then the folded remainders, so the layout keeps
    // each lane in that order.
    const componentNodes: ViewNode[] = [];
    const packageNodes: ViewNode[] = [];
    const moreNodes: ViewNode[] = [];
    const edges: ViewEdge[] = [];
    const componentIds = new Set<string>();
    const componentNode = (id: string) => `component:${id}`;

    for (const c of components) {
      const fact = facts.get(c.id);
      const list = uses.get(c.id) ?? [];
      const shown = list
        .slice(0, MAX_PACKAGES_PER_COMPONENT)
        .filter((u) => kept.has(u.key));
      const hidden = list.filter((u) => !shown.includes(u));
      for (const use of shown) {
        edges.push({
          from: componentNode(c.id),
          to: `package:${use.key}`,
          label: use.count ? `×${use.count}` : 'declared',
        });
      }
      if (hidden.length) {
        moreNodes.push({
          id: `more:${c.id}`,
          name: `${hidden.length} more packages`,
          kind: 'more',
          detail: hidden.map((u) => u.name).join(', '),
          group: PACKAGES_GROUP,
        });
        edges.push({
          from: componentNode(c.id),
          to: `more:${c.id}`,
          label: '',
        });
      }
      for (const [target, { count }] of fact?.dependsOn ?? []) {
        edges.push({
          from: componentNode(c.id),
          to: componentNode(target),
          label: `imports ×${count}`,
        });
        componentIds.add(target);
      }
      if (list.length || fact?.dependsOn.size) componentIds.add(c.id);
    }

    for (const c of components.filter((c) => componentIds.has(c.id))) {
      const packages = uses.get(c.id)?.length ?? 0;
      const internal = facts.get(c.id)?.dependsOn.size ?? 0;
      const unused = notImported.get(c.id) ?? 0;
      const manifest = manifestOf.get(c.id);
      componentNodes.push({
        id: componentNode(c.id),
        name: c.name,
        kind: 'component',
        detail: [
          `${packages} ${packages === 1 ? 'package' : 'packages'}`,
          internal &&
            `imports ${internal} ${internal === 1 ? 'component' : 'components'}`,
          unused && `${unused} declared but not imported in code`,
        ]
          .filter(Boolean)
          .join(' · '),
        group: COMPONENTS_GROUP,
        componentId: c.id,
        ...(manifest && { path: manifest }),
      });
    }

    for (const [key, { use, components: count }] of kept) {
      const d = use.declared;
      packageNodes.push({
        id: `package:${key}`,
        name: use.name,
        kind: d?.dev ? 'dev' : 'package',
        detail: [
          d?.ecosystem,
          d?.version,
          `used by ${count} ${count === 1 ? 'component' : 'components'}`,
        ]
          .filter(Boolean)
          .join(' · '),
        group: PACKAGES_GROUP,
        ...(d && { path: d.manifest }),
      });
    }

    const nodes = [...componentNodes, ...packageNodes, ...moreNodes];
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    } satisfies ViewGraph;
  },
};
