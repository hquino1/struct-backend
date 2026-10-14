// Single-table item: PK = USER#<cognito sub>, SK = PROJECT#<projectId>.
export interface ProjectItem {
  PK: string;
  SK: string;
  name: string;
  repoUrl: string;
  branch: string;
  createdAT: string;
}

export interface Project {
  projectId: string;
  name: string;
  repoUrl: string;
  branch: string;
  createdAt: string;
}

export const userKey = (userId: string) => `USER#${userId}`;
export const projectKey = (projectId: string) => `PROJECT#${projectId}`;

export const toProject = (item: ProjectItem): Project => ({
  projectId: item.SK.slice('PROJECT#'.length),
  name: item.name,
  repoUrl: item.repoUrl,
  branch: item.branch,
  createdAt: item.createdAT,
});
