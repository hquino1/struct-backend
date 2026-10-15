import {
  NOT_STARTED,
  toAnalysis,
  type AnalysisStep,
  type ProjectAnalysis,
} from '../analyses/analysis.entity.js';

// Single-table item: PK = USER#<cognito sub>, SK = PROJECT#<projectId>.
export interface ProjectItem {
  PK: string;
  SK: string;
  name: string;
  repoUrl: string;
  branch: string;
  createdAT: string;
  // Latest analysis run; missing on projects created before analysis existed.
  analysis?: ProjectAnalysis;
}

export interface Project {
  projectId: string;
  name: string;
  repoUrl: string;
  branch: string;
  createdAt: string;
  analysisStatus: ProjectAnalysis['status'];
  // The step the latest run is on (or stopped at); null before the first run.
  analysisStep: AnalysisStep | null;
}

export const userKey = (userId: string) => `USER#${userId}`;
export const projectKey = (projectId: string) => `PROJECT#${projectId}`;

export const toProject = (item: ProjectItem): Project => {
  const projectId = item.SK.slice('PROJECT#'.length);
  // Through toAnalysis so a run whose worker died reads as FAILED here too.
  const analysis = toAnalysis(projectId, item.analysis);
  return {
    projectId,
    name: item.name,
    repoUrl: item.repoUrl,
    branch: item.branch,
    createdAt: item.createdAT,
    analysisStatus: analysis?.status ?? NOT_STARTED.status,
    analysisStep: analysis?.step ?? null,
  };
};
