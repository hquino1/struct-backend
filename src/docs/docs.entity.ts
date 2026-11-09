import { gunzipSync, gzipSync } from 'node:zlib';
import { HEARTBEAT_TIMEOUT_MS } from '../analyses/analysis.entity.js';

// Shared by the API (which reads docs and starts docs runs) and the worker (which writes
// them). Docs cover a selection of the repository's files: the suggested ones ("auto") or
// the user's own pick ("manual").

// Keeps one run's time and AI cost bounded.
export const MAX_DOC_FILES = 25;
// How many files "auto" documents, from the top of the suggestions.
export const MAX_SUGGESTIONS = 12;

export type DocsMode = 'auto' | 'manual';
export type DocsStatus = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'FAILED';

// The `docs` attribute of a project item: how files are picked, and the latest docs run.
// Runs come from an analysis (its last phase) or from the user changing the selection.
export interface ProjectDocs {
  mode: DocsMode;
  // The user's pick; only used in manual mode.
  selection?: string[];
  status?: DocsStatus;
  // Every worker write is conditioned on this, so a replaced run stops at its next write.
  runId?: string;
  startedAt?: string;
  heartbeatAt?: string;
  finishedAt?: string;
  // The commit being documented.
  commit?: string;
  total?: number;
  done?: number;
  // Files the model couldn't document in the latest run.
  failed?: string[];
  error?: string;
}

export const DEFAULT_DOCS: ProjectDocs = { mode: 'auto' };

// A file worth documenting, and why it was picked.
export interface DocSuggestion {
  path: string;
  reason: string;
}

// The latest completed analysis's documentable files: SK = FILES#<projectId>. The path list
// is gzipped JSON, which keeps even 20,000 paths far under the 400 KB item limit.
export const filesKey = (projectId: string) => `FILES#${projectId}`;

export interface FilesItem {
  PK: string;
  SK: string;
  analysisId: string;
  commit: string;
  paths: Uint8Array;
  suggestions: DocSuggestion[];
}

export const packPaths = (paths: string[]) =>
  gzipSync(JSON.stringify(paths), { level: 9 });
export const unpackPaths = (packed: Uint8Array): string[] =>
  JSON.parse(gunzipSync(packed).toString('utf8')) as string[];

// One documented file: SK = DOC#<projectId>#<path>, so a project's docs are one Query.
export const docPrefix = (projectId: string) => `DOC#${projectId}#`;
export const docKey = (projectId: string, path: string) =>
  `${docPrefix(projectId)}${path}`;

export const KEY_PART_KINDS = [
  'function',
  'class',
  'component',
  'hook',
  'route',
  'type',
  'constant',
  'config',
  'other',
] as const;

export interface FileDoc {
  path: string;
  // The commit the doc describes, for source links.
  commit: string;
  // sha256 of the file's contents, so unchanged files aren't documented again.
  hash: string;
  componentId?: string;
  summary: string;
  purpose: string;
  keyParts: {
    name: string;
    kind: (typeof KEY_PART_KINDS)[number];
    description: string;
    line?: number;
  }[];
  notes: string[];
  // Repository files that import this one, and the ones it imports.
  usedBy: string[];
  dependsOn: string[];
  // HTTP routes this file serves, e.g. "GET /projects".
  endpoints: string[];
  // The file was longer than what the model read.
  truncated: boolean;
  generatedAt: string;
}

export interface DocItem {
  PK: string;
  SK: string;
  runId: string;
  doc: FileDoc;
}

// Docs as the API returns them.
export interface DocsState {
  mode: DocsMode;
  // The files being documented: the suggestions in auto mode, the user's pick otherwise.
  selection: string[];
  status: DocsStatus | 'NOT_STARTED';
  total?: number;
  done?: number;
  commit?: string;
  finishedAt?: string;
  failed: string[];
  error?: string;
  docs: FileDoc[];
}

export const isDocsActive = (docs: ProjectDocs | undefined) =>
  docs?.status === 'QUEUED' || docs?.status === 'RUNNING';

// A run whose worker died never writes FAILED itself.
export const isDocsStale = (docs: ProjectDocs | undefined, now = Date.now()) =>
  isDocsActive(docs) &&
  now - Date.parse(docs?.heartbeatAt ?? '') > HEARTBEAT_TIMEOUT_MS;

export const toDocsState = (
  docs: ProjectDocs = DEFAULT_DOCS,
  suggestions: DocSuggestion[],
  saved: FileDoc[],
  now = Date.now(),
): DocsState => {
  const stale = isDocsStale(docs, now);
  return {
    mode: docs.mode,
    selection:
      docs.mode === 'manual'
        ? (docs.selection ?? [])
        : suggestions.map((s) => s.path),
    status: stale ? 'FAILED' : (docs.status ?? 'NOT_STARTED'),
    total: docs.total,
    done: docs.done,
    commit: docs.commit,
    finishedAt: docs.finishedAt,
    failed: docs.failed ?? [],
    error: stale
      ? 'Writing the docs stopped responding. Try again.'
      : docs.error,
    docs: saved.sort((a, b) => a.path.localeCompare(b.path)),
  };
};

// Files worth documenting: source code and the configuration that shapes a system, minus
// lockfiles and minified bundles.
export const isDocumentable = (path: string) =>
  !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.[cm]?js$|\.map$|\.d\.ts$/.test(
    path,
  ) &&
  /\.(m|c)?[jt]sx?$|\.(py|go|rs|java|kt|cs|rb|php|swift|c|h|cpp|hpp|vue|svelte|sql|prisma|tf|graphql|proto|ya?ml|toml)$|(^|\/)(Dockerfile|Makefile)$/i.test(
    path,
  );
