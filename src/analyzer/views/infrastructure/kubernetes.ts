import {
  allStrings,
  isRecord,
  readYamlDocuments,
  text,
  type YamlMap,
} from '../shared.js';
import {
  categorizeImage,
  type Category,
  type Collected,
  type Source,
} from './model.js';

// Kubernetes manifests: workloads, the Services that select them, the Ingresses that route
// to those Services, and the volume claims they mount. Helm templates aren't valid YAML
// until rendered, so they're skipped.

const MANIFEST = /\.ya?ml$/i;
const SKIP =
  /(^|\/)(\.github\/|templates\/|(docker-)?compose[^/]*\.ya?ml$|serverless\.ya?ml$|\.gitlab-ci\.yml$)/i;
const MAX_CANDIDATES = 500;

const WORKLOADS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'Pod',
]);
const CATEGORIES: Record<string, Category> = {
  Service: 'network',
  Ingress: 'network',
  HTTPRoute: 'network',
  PersistentVolumeClaim: 'data',
};

const get = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((v, k) => (isRecord(v) ? v[k] : undefined), value);
const records = (value: unknown): YamlMap[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

// The pod template of any workload kind.
const podOf = (doc: YamlMap) =>
  doc['kind'] === 'Pod'
    ? { spec: doc['spec'], labels: get(doc, 'metadata', 'labels') }
    : doc['kind'] === 'CronJob'
      ? {
          spec: get(doc, 'spec', 'jobTemplate', 'spec', 'template', 'spec'),
          labels: get(
            doc,
            'spec',
            'jobTemplate',
            'spec',
            'template',
            'metadata',
            'labels',
          ),
        }
      : {
          spec: get(doc, 'spec', 'template', 'spec'),
          labels: get(doc, 'spec', 'template', 'metadata', 'labels'),
        };

interface K8sObject {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  doc: YamlMap;
}

export const kubernetes: Source = async ({ repoDir, paths }) => {
  const collected: Collected = { resources: [], links: [] };
  const objects: K8sObject[] = [];
  const candidates = paths
    .filter((p) => MANIFEST.test(p) && !SKIP.test(p))
    .slice(0, MAX_CANDIDATES);
  for (const path of candidates) {
    for (const doc of await readYamlDocuments(repoDir, path)) {
      const kind = text(doc['kind']);
      const name = text(get(doc, 'metadata', 'name'));
      if (!doc['apiVersion'] || !kind || !name) continue;
      if (!WORKLOADS.has(kind) && !CATEGORIES[kind]) continue;
      const namespace = text(get(doc, 'metadata', 'namespace')) ?? 'default';
      const id = `k8s:${namespace}/${kind}/${name}`;
      if (objects.some((o) => o.id === id)) continue;
      objects.push({ id, kind, name, namespace, doc });
      const images = records(
        podOf(doc).spec && get(podOf(doc).spec, 'containers'),
      )
        .map((c) => text(c['image']))
        .filter((i): i is string => !!i);
      collected.resources.push({
        id,
        name,
        type: kind,
        category: WORKLOADS.has(kind)
          ? categorizeImage(images.join(' ') || name)
          : CATEGORIES[kind]!,
        detail: [kind, images[0], namespace !== 'default' && `ns ${namespace}`]
          .filter(Boolean)
          .join(' · '),
        path,
      });
    }
  }
  if (!objects.length) return collected;

  const inNamespace = (namespace: string, kind: string) =>
    objects.filter((o) => o.namespace === namespace && o.kind === kind);
  for (const o of objects) {
    if (o.kind === 'Service') {
      // Routes to the workloads whose pod labels include every selector label.
      const selector = get(o.doc, 'spec', 'selector');
      if (!isRecord(selector) || !Object.keys(selector).length) continue;
      for (const w of objects.filter(
        (w) => w.namespace === o.namespace && WORKLOADS.has(w.kind),
      )) {
        const labels = podOf(w.doc).labels;
        if (
          isRecord(labels) &&
          Object.entries(selector).every(([k, v]) => labels[k] === v)
        ) {
          collected.links.push({ from: o.id, to: w.id, label: 'routes to' });
        }
      }
    } else if (o.kind === 'Ingress' || o.kind === 'HTTPRoute') {
      // Every backend service name in the routing rules (Ingress v1, older Ingress, Gateway API).
      const spec = get(o.doc, 'spec');
      const backends = new Set<string>();
      const walk = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (isRecord(value)) {
          const name =
            text(get(value, 'service', 'name')) ?? text(value['serviceName']);
          if (name) backends.add(name);
          for (const ref of records(value['backendRefs'])) {
            const refName = text(ref['name']);
            if (refName) backends.add(refName);
          }
          Object.values(value).forEach(walk);
        }
      };
      walk(spec);
      for (const s of inNamespace(o.namespace, 'Service')) {
        if (backends.has(s.name))
          collected.links.push({ from: o.id, to: s.id, label: 'routes to' });
      }
    } else if (WORKLOADS.has(o.kind)) {
      const pod = podOf(o.doc).spec;
      // Volume claims it mounts.
      const claims = new Set(
        records(get(pod, 'volumes'))
          .map((v) => text(get(v, 'persistentVolumeClaim', 'claimName')))
          .filter(Boolean),
      );
      for (const c of inNamespace(o.namespace, 'PersistentVolumeClaim')) {
        if (claims.has(c.name))
          collected.links.push({ from: o.id, to: c.id, label: 'mounts' });
      }
      // Services named in its env, as a host or cluster DNS name (`orders`, `orders.shop.svc`).
      const env = new Set(
        records(get(pod, 'containers'))
          .flatMap((c) => records(c['env']))
          .flatMap((e) => allStrings(e['value']))
          .flatMap((s) => s.split(/[^A-Za-z0-9-]+/)),
      );
      for (const s of inNamespace(o.namespace, 'Service')) {
        if (env.has(s.name))
          collected.links.push({ from: o.id, to: s.id, label: 'connects' });
      }
    }
  }
  return collected;
};
