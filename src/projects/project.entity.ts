import {
  NOT_STARTED,
  toAnalysis,
  type AnalysisStep,
  type ProjectAnalysis,
} from '../analyses/analysis.entity.js';
import type { ProjectDocs } from '../docs/docs.entity.js';

// Single-table item: PK = USER#<cognito sub>, SK = PROJECT#<projectId>.
export interface ProjectItem {
  PK: string;
  SK: string;
  name: string;
  repoUrl: string;
  branch: string;
  createdAT: string;
  // Set for private repositories, which the worker clones through this GitHub App installation.
  installationId?: number;
  // Latest analysis run; missing on projects created before analysis existed.
  analysis?: ProjectAnalysis;
  // Which files to document, and the latest docs run; missing until the first one.
  docs?: ProjectDocs;
}

export interface Project {
  projectId: string;
  name: string;
  repoUrl: string;
  branch: string;
  createdAt: string;
  // Read through the Struct GitHub App rather than anonymously.
  private: boolean;
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
    private: item.installationId !== undefined,
    analysisStatus: analysis?.status ?? NOT_STARTED.status,
    analysisStep: analysis?.step ?? null,
  };
};
