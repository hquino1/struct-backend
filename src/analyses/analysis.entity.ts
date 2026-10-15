import type { ArchitectureGraph } from '../analyzer/architecture.js';
import type {
  ViewGraph,
  ViewId,
  ViewStatus,
} from '../analyzer/views/view-graph.js';

// Shared by the API (which starts and reads analyses) and the worker (which runs them).

export const ANALYSIS_STEPS = [
  'clone',
  'detect',
  'map',
  'trace',
  'insights',
] as const;
export type AnalysisStep = (typeof ANALYSIS_STEPS)[number];

export type AnalysisStatus = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'FAILED';

export interface AnalysisStats {
  files: number;
  // File count per language, e.g. { TypeScript: 120, CSS: 8 }.
  languages: Record<string, number>;
}

// The `analysis` attribute of a project item: its latest run, overwritten by each new one.
// Projects start as NOT_STARTED with no step; every other field arrives with the first run.
export interface ProjectAnalysis {
  status: AnalysisStatus | 'NOT_STARTED';
  step: AnalysisStep | null;
  analysisId?: string;
  startedAt?: string;
  // Bumped by the worker while it runs; a stale heartbeat means the task died.
  heartbeatAt?: string;
  finishedAt?: string;
  commit?: string;
  stats?: AnalysisStats;
  error?: string;
  // Which explore views the run built; set when it completes.
  views?: AnalysisViews;
}

export type AnalysisViews = Partial<Record<ViewId, ViewStatus>>;

export const NOT_STARTED: ProjectAnalysis = {
  status: 'NOT_STARTED',
  step: null,
};

// A run as the API returns it.
export interface Analysis {
  analysisId: string;
  projectId: string;
  status: AnalysisStatus;
  step: AnalysisStep;
  startedAt: string;
  finishedAt?: string;
  commit?: string;
  stats?: AnalysisStats;
  error?: string;
  views?: AnalysisViews;
}

// The latest completed run's architecture graph: SK = GRAPH#<projectId>. Kept off the
// project item so listing projects and polling progress never download the graph.
export const graphKey = (projectId: string) => `GRAPH#${projectId}`;

export interface GraphItem {
  PK: string;
  SK: string;
  analysisId: string;
  graph: ArchitectureGraph;
}

// A graph as the API returns it, tagged with the run that produced it.
export interface SavedGraph extends ArchitectureGraph {
  projectId: string;
  analysisId: string;
}

// One explore view from the latest completed run: SK = VIEW#<projectId>#<view>. Each view
// is its own item so none can push another past DynamoDB's 400 KB item limit, and the
// frontend downloads only the views it opens.
export const viewKey = (projectId: string, view: ViewId) =>
  `VIEW#${projectId}#${view}`;

export interface ViewItem {
  PK: string;
  SK: string;
  analysisId: string;
  view: ViewId;
  graph: ViewGraph;
}

export interface SavedView extends ViewGraph {
  projectId: string;
  analysisId: string;
  view: ViewId;
}

// Covers Fargate startup (image pull) plus the longest gap between worker heartbeats.
export const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;

export const isActive = (status: ProjectAnalysis['status']) =>
  status === 'QUEUED' || status === 'RUNNING';

export const isStale = (analysis: ProjectAnalysis, now = Date.now()) =>
  isActive(analysis.status) &&
  now - Date.parse(analysis.heartbeatAt ?? '') > HEARTBEAT_TIMEOUT_MS;

// The project's latest run, or null if it was never analyzed. Projects created before the
// `analysis` attribute existed have none and count as never analyzed.
export const toAnalysis = (
  projectId: string,
  analysis: ProjectAnalysis | undefined,
  now = Date.now(),
): Analysis | null => {
  if (!analysis?.analysisId || analysis.status === 'NOT_STARTED') return null;
  const run = {
    analysisId: analysis.analysisId,
    projectId,
    step: analysis.step ?? 'clone',
    startedAt: analysis.startedAt ?? '',
  };
  // A task killed outright (out of memory, stopped) never writes FAILED itself.
  if (isStale(analysis, now)) {
    return {
      ...run,
      status: 'FAILED',
      error: 'The analysis stopped responding. Try running it again.',
    };
  }
  return {
    ...run,
    status: analysis.status,
    finishedAt: analysis.finishedAt,
    commit: analysis.commit,
    stats: analysis.stats,
    error: analysis.error,
    views: analysis.views,
  };
};
