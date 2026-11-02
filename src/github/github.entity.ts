// Single-table item: PK = USER#<cognito sub>, SK = GITHUB. The GitHub account the user
// proved they own by authorizing the Struct GitHub App. No GitHub token is stored: access to
// a private repository is checked against this account each time it matters.
export interface GitHubConnectionItem {
  PK: string;
  SK: string;
  githubUserId: number;
  login: string;
  connectedAt: string;
}

export const GITHUB_CONNECTION_KEY = 'GITHUB';

export interface GitHubConnection {
  // False when the server has no GitHub App configured; only public repositories work then.
  enabled: boolean;
  login: string | null;
  // Installs the app on more repositories; connects the account too when the user approves.
  installUrl: string | null;
  // Connects the account without changing which repositories the app can read.
  authorizeUrl: string | null;
}
