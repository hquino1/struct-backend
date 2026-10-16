import type { Component } from '../architecture.js';
import type { LlmService } from '../llm.service.js';
import type { CodeFacts } from '../repo-digest.js';

// The explore views built alongside the architecture graph. Each one is extracted from
// files with a known structure, so most need no model call. Shared with the API, so this
// file must stay free of worker-only dependencies.

export const VIEW_IDS = [
  'screens',
  'dependencies',
  'schema',
  'api',
  'calls',
  'infrastructure',
  'ci-cd',
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const isViewId = (value: string): value is ViewId =>
  (VIEW_IDS as readonly string[]).includes(value);

// NOT_APPLICABLE: the repository has nothing this view draws (e.g. no CI configuration).
export type ViewStatus = 'COMPLETE' | 'NOT_APPLICABLE' | 'FAILED';

export interface ViewNode {
  id: string;
  name: string;
  // What the node is within its view, e.g. "trigger", "job", or "deploy" for CI/CD.
  kind: string;
  detail: string;
  // The band the node is drawn in, e.g. the workflow a job belongs to.
  group: string;
  // The file that defines it, relative to the repo root.
  path?: string;
  // The architecture component it belongs to, so selection can carry across views.
  componentId?: string;
  // Columns or attributes, for views of data such as the database schema.
  fields?: ViewField[];
}

export interface ViewField {
  name: string;
  type: string;
  key?: 'primary' | 'foreign' | 'partition' | 'sort' | 'unique';
}

export interface ViewEdge {
  from: string;
  to: string;
  label: string;
}

export interface ViewGraph {
  nodes: ViewNode[];
  edges: ViewEdge[];
}

export interface ViewContext {
  repoDir: string;
  paths: string[];
  components: Component[];
  // What each component's code imports, from the scan the trace step uses.
  facts: CodeFacts;
  // For the parts of a view that can't be parsed, such as ORM classes. Views call it only
  // when they find something worth asking about.
  llm: Pick<LlmService, 'callTool'>;
}

export interface ViewExtractor {
  view: ViewId;
  // A cheap check on file paths alone, so views that can't apply cost nothing.
  applies(paths: string[]): boolean;
  extract(context: ViewContext): Promise<ViewGraph>;
}
