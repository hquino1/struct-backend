import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Calls the GitHub REST API with an app, installation, or user token.
export async function githubRequest<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Struct',
      ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new GitHubApiError(
      res.status,
      `GitHub ${method} ${path} returned ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export type RepositoryPermissions = Partial<
  Record<'contents' | 'metadata', 'read'>
>;

// Acts as the Struct GitHub App. Shared by the API (finding installations, checking access)
// and the worker (cloning). Disabled when GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is unset,
// in which case only public repositories can be analyzed.
@Injectable()
export class GitHubAppService {
  private readonly appId?: string;
  private readonly privateKey?: KeyObject;

  constructor(config: ConfigService) {
    this.appId = config.get<string>('GITHUB_APP_ID') || undefined;
    const pem = config.get<string>('GITHUB_APP_PRIVATE_KEY');
    // Accepts the PEM with real newlines or with `\n` escapes, as one-line env values need.
    this.privateKey = pem
      ? createPrivateKey(pem.replace(/\\n/g, '\n'))
      : undefined;
  }

  get enabled(): boolean {
    return Boolean(this.appId && this.privateKey);
  }

  // The installation that covers owner/repo, or undefined when the app isn't installed on it.
  async findInstallation(
    owner: string,
    repo: string,
  ): Promise<number | undefined> {
    try {
      const { id } = await githubRequest<{ id: number }>(
        `/repos/${owner}/${repo}/installation`,
        this.appJwt(),
      );
      return id;
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  // An hour-long token limited to one repository and the given permissions.
  async repositoryToken(
    installationId: number,
    repo: string,
    permissions: RepositoryPermissions,
  ): Promise<string> {
    const { token } = await githubRequest<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      this.appJwt(),
      { method: 'POST', body: { repositories: [repo], permissions } },
    );
    return token;
  }

  // Signs in as the app itself; GitHub allows at most 10 minutes.
  private appJwt(): string {
    if (!this.enabled) throw new Error('The GitHub App is not configured');
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    // Backdated a minute to allow for clock drift.
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: this.appId,
    })}`;
    const signature = sign('sha256', Buffer.from(unsigned), this.privateKey!);
    return `${unsigned}.${signature.toString('base64url')}`;
  }
}
