import { parse } from 'yaml';
import {
  allStrings,
  basename,
  dirOf,
  isRecord,
  readConfig,
  text,
  withComponent,
  type ComponentFinder,
  type YamlMap,
} from '../shared.js';
import { categorize, type Collected, type Source } from './model.js';

// CloudFormation and SAM templates, and the Serverless Framework (whose `resources` block
// is CloudFormation). References are found by name: `!Ref Table`, `!GetAtt Table.Arn`, and
// `${Table}` all mention the logical id, and logical ids are plain alphanumerics.

const CANDIDATE = /\.(ya?ml|json|template)$/i;
const SKIP =
  /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|composer\.json|[^/]*lock[^/]*|\.github\/.*|(docker-)?compose[^/]*\.ya?ml|serverless\.ya?ml)$/i;
const LOOKS_LIKE_CFN =
  /AWSTemplateFormatVersion|Transform["']?\s*:\s*["']?AWS::Serverless|["']?Type["']?\s*:\s*["']?AWS::/;
const SERVERLESS = /(^|\/)serverless\.ya?ml$/;
// Plenty for real stacks; bounds the time spent reading unrelated YAML and JSON.
const MAX_CANDIDATES = 500;

const YAML_OPTIONS = { merge: true, logLevel: 'error' } as const;

function parseTemplate(content: string): YamlMap | undefined {
  try {
    const doc: unknown = parse(content, YAML_OPTIONS);
    return isRecord(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

const tokens = (value: unknown) =>
  new Set(allStrings(value).flatMap((s) => s.split(/[^A-Za-z0-9]+/)));

// Adds a template's resources and the references between them. `prefix` keeps ids unique
// per file; SAM function events point the other way (the queue triggers the function).
function addResources(
  resources: YamlMap,
  path: string,
  findComponent: ComponentFinder,
  collected: Collected,
) {
  const prefix = `cfn:${path}:`;
  const logicalIds = new Set(Object.keys(resources));
  let implicitApi: string | undefined;

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!isRecord(resource)) continue;
    const type = text(resource['Type']) ?? 'Unknown';
    const properties = isRecord(resource['Properties'])
      ? resource['Properties']
      : {};
    const events = isRecord(properties['Events']) ? properties['Events'] : {};
    const id = prefix + logicalId;
    collected.resources.push({
      id,
      name: logicalId,
      type,
      category: categorize(type),
      detail: `${type} · ${basename(path)}`,
      path,
      ...withComponent(
        findComponent(
          dirOf(path),
          properties['CodeUri'],
          properties['Handler'],
          properties['Code'],
        ),
      ),
    });

    const { Events: _events, ...rest } = properties;
    const uses = tokens([rest, resource['DependsOn']]);
    for (const target of logicalIds) {
      if (target !== logicalId && uses.has(target)) {
        collected.links.push({ from: id, to: prefix + target, label: 'uses' });
      }
    }
    for (const event of Object.values(events)) {
      if (!isRecord(event)) continue;
      const eventType = text(event['Type']) ?? '';
      const triggers = tokens(event['Properties']);
      let fromApi = false;
      for (const target of logicalIds) {
        if (target !== logicalId && triggers.has(target)) {
          collected.links.push({
            from: prefix + target,
            to: id,
            label: 'triggers',
          });
          fromApi ||= eventType.endsWith('Api');
        }
      }
      // SAM creates an API for Api events that don't name one.
      if (/^(Http)?Api$/.test(eventType) && !fromApi) {
        if (!implicitApi) {
          implicitApi = `${prefix}ImplicitApi`;
          collected.resources.push({
            id: implicitApi,
            name: 'API',
            type: 'AWS::Serverless::Api',
            category: 'network',
            detail: `API Gateway (implicit) · ${basename(path)}`,
            path,
          });
        }
        collected.links.push({ from: implicitApi, to: id, label: 'routes to' });
      }
    }
  }
}

function addServerless(
  doc: YamlMap,
  path: string,
  findComponent: ComponentFinder,
  collected: Collected,
) {
  const service = text(doc['service']) ?? basename(dirOf(path) || 'service');
  const prefix = `sls:${path}:`;
  const cfn = isRecord(doc['resources'])
    ? doc['resources']['Resources']
    : undefined;
  const resources = isRecord(cfn) ? cfn : {};
  if (isRecord(cfn)) addResources(cfn, path, findComponent, collected);
  const logicalIds = new Set(Object.keys(resources));
  const functions = isRecord(doc['functions']) ? doc['functions'] : {};
  let api: string | undefined;

  for (const [name, fn] of Object.entries(functions)) {
    if (!isRecord(fn)) continue;
    const id = prefix + name;
    collected.resources.push({
      id,
      name,
      type: 'Serverless function',
      category: 'compute',
      detail: `Lambda · ${text(fn['handler']) ?? service}`,
      path,
      ...withComponent(findComponent(dirOf(path), fn['handler'])),
    });
    for (const event of Array.isArray(fn['events']) ? fn['events'] : []) {
      if (!isRecord(event)) continue;
      const [kind] = Object.keys(event);
      if (kind === 'http' || kind === 'httpApi') {
        if (!api) {
          api = `${prefix}api`;
          collected.resources.push({
            id: api,
            name: `${service} API`,
            type: 'API Gateway',
            category: 'network',
            detail: `API Gateway · ${basename(path)}`,
            path,
          });
        }
        collected.links.push({ from: api, to: id, label: 'routes to' });
        continue;
      }
      const triggers = tokens(event);
      for (const target of logicalIds) {
        if (triggers.has(target)) {
          collected.links.push({
            from: `cfn:${path}:${target}`,
            to: id,
            label: 'triggers',
          });
        }
      }
    }
    // Environment variables naming a resource (`TABLE: !Ref Orders`) are uses.
    const uses = tokens(fn['environment']);
    for (const target of logicalIds) {
      if (uses.has(target)) {
        collected.links.push({
          from: id,
          to: `cfn:${path}:${target}`,
          label: 'uses',
        });
      }
    }
  }
}

export const cloudFormation: Source = async ({
  repoDir,
  paths,
  findComponent,
}) => {
  const collected: Collected = { resources: [], links: [] };
  for (const path of paths.filter((p) => SERVERLESS.test(p))) {
    const content = await readConfig(repoDir, path);
    const doc = content ? parseTemplate(content) : undefined;
    if (doc) addServerless(doc, path, findComponent, collected);
  }
  const candidates = paths
    .filter((p) => CANDIDATE.test(p) && !SKIP.test(p))
    .slice(0, MAX_CANDIDATES);
  for (const path of candidates) {
    const content = await readConfig(repoDir, path);
    if (!content || !LOOKS_LIKE_CFN.test(content)) continue;
    const doc = parseTemplate(content);
    const resources = doc?.['Resources'];
    if (isRecord(resources))
      addResources(resources, path, findComponent, collected);
  }
  return collected;
};
