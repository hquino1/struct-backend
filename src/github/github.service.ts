import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
import { GITHUB_REPO_URL } from '../projects/dto/create-project.dto.js';
import { userKey } from '../projects/project.entity.js';
import {
  GitHubApiError,
  GitHubAppService,
  githubRequest,
} from './github-app.service.js';
import {
  GITHUB_CONNECTION_KEY,
  type GitHubConnection,
  type GitHubConnectionItem,
  type RepositoryBranches,
} from './github.entity.js';

// Long enough to pick repositories on GitHub's install page.
const STATE_TTL_MS = 60 * 60 * 1000;
// GitHub's largest page; listing stops after MAX_BRANCH_PAGES of them.
const BRANCHES_PER_PAGE = 100;
const MAX_BRANCH_PAGES = 10;

// API side: links a user to their GitHub account and decides whether they may analyze a
// private repository.
@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private readonly tableName: string;
  private readonly slug?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;

  constructor(
    @Inject(DYNAMODB_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly app: GitHubAppService,
    config: ConfigService,
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
    this.slug = config.get<string>('GITHUB_APP_SLUG') || undefined;
    this.clientId = config.get<string>('GITHUB_CLIENT_ID') || undefined;
    this.clientSecret = config.get<string>('GITHUB_CLIENT_SECRET') || undefined;
  }

  get enabled(): boolean {
    return Boolean(
      this.app.enabled && this.slug && this.clientId && this.clientSecret,
    );
  }

  async getConnection(userId: string): Promise<GitHubConnection> {
    if (!this.enabled) {
      return {
        enabled: false,
        login: null,
        installUrl: null,
        authorizeUrl: null,
      };
    }
    const item = await this.findConnection(userId);
    const state = encodeURIComponent(this.signState(userId));
    return {
      enabled: true,
      login: item?.login ?? null,
      installUrl: `https://github.com/apps/${this.slug}/installations/new?state=${state}`,
      authorizeUrl: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(this.clientId!)}&state=${state}`,
    };
  }

  // Finishes GitHub's redirect: proves which GitHub account the user owns and saves it.
  async connect(
    userId: string,
    code: string,
    state: string,
  ): Promise<GitHubConnection> {
    this.assertEnabled();
    // Stops another person's GitHub account from being linked through a crafted link.
    if (!this.verifyState(state, userId)) {
      throw new BadRequestException(
        'This GitHub link has expired or belongs to another session. Try connecting again.',
      );
    }

    const userToken = await this.exchangeCode(code);
    let githubUser: { id: number; login: string };
    try {
      githubUser = await githubRequest('/user', userToken);
    } catch (err) {
      throw this.unavailable(err);
    }

    const item: GitHubConnectionItem = {
      PK: userKey(userId),
      SK: GITHUB_CONNECTION_KEY,
      githubUserId: githubUser.id,
      login: githubUser.login,
      connectedAt: new Date().toISOString(),
    };
    await this.db.send(
      new PutCommand({ TableName: this.tableName, Item: item }),
    );
    return this.getConnection(userId);
  }

  async disconnect(userId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: GITHUB_CONNECTION_KEY },
      }),
    );
  }

  // How a new project's repository will be read: through the app installation (returned)
  // when it's private and the user may read it, or anonymously (undefined) otherwise.
  async resolveRepository(
    userId: string,
    owner: string,
    repo: string,
  ): Promise<number | undefined> {
    if (!this.app.enabled) return undefined;
    try {
      const installationId = await this.app.findInstallation(owner, repo);
      // Either public, or not shared with Struct; the clone tells the two apart.
      if (installationId === undefined) return undefined;

      const token = await this.app.repositoryToken(installationId, repo, {
        metadata: 'read',
      });
      const repository = await githubRequest<{ private: boolean }>(
        `/repos/${owner}/${repo}`,
        token,
      );
      if (!repository.private) return undefined;

      await this.assertAccess(userId, owner, repo, token);
      return installationId;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw this.unavailable(err);
    }
  }

  // Run before every analysis of a private repository, so someone who has since lost access
  // on GitHub (e.g. left the organization) can't keep reading it through Struct.
  async assertCanRead(
    userId: string,
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<void> {
    await this.readToken(userId, owner, repo, installationId);
  }

  // The branches of a repository that isn't a project yet, with the same access check an
  // import makes.
  async listRepositoryBranches(
    userId: string,
    repoUrl: string,
  ): Promise<RepositoryBranches> {
    // The DTO already validated the URL, so the match always succeeds.
    const [, owner, repo] = GITHUB_REPO_URL.exec(repoUrl)!;
    const installationId = await this.resolveRepository(userId, owner, repo);
    return this.listBranches(userId, owner, repo, installationId);
  }

  // The branches of a repository, read the way an analysis will read it: through
  // `installationId` when it's private, anonymously otherwise.
  async listBranches(
    userId: string,
    owner: string,
    repo: string,
    installationId?: number,
  ): Promise<RepositoryBranches> {
    const token = await this.readToken(userId, owner, repo, installationId);
    return this.readRepository(owner, repo, token, async () => {
      const { default_branch } = await githubRequest<{
        default_branch: string;
      }>(`/repos/${owner}/${repo}`, token);
      const branches: string[] = [];
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const batch = await githubRequest<{ name: string }[]>(
          `/repos/${owner}/${repo}/branches?per_page=${BRANCHES_PER_PAGE}&page=${page}`,
          token,
        );
        branches.push(...batch.map((b) => b.name));
        if (batch.length < BRANCHES_PER_PAGE) {
          return { defaultBranch: default_branch, branches, truncated: false };
        }
      }
      return { defaultBranch: default_branch, branches, truncated: true };
    });
  }

  // The branch a project will track: `branch` once GitHub confirms it exists, or the
  // repository's default branch when none is given.
  async resolveBranch(
    userId: string,
    owner: string,
    repo: string,
    installationId: number | undefined,
    branch?: string,
  ): Promise<string> {
    const token = await this.readToken(userId, owner, repo, installationId);
    return this.readRepository(owner, repo, token, async () => {
      const { default_branch } = await githubRequest<{
        default_branch: string;
      }>(`/repos/${owner}/${repo}`, token);
      if (!branch || branch === default_branch) return default_branch;
      try {
        await githubRequest(
          `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
          token,
        );
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 404) {
          throw new BadRequestException(
            `${owner}/${repo} has no branch named "${branch}".`,
          );
        }
        throw err;
      }
      return branch;
    });
  }

  // The installation token that reads a private repository, once the user's access is
  // confirmed; undefined for a public one, which is read anonymously.
  private async readToken(
    userId: string,
    owner: string,
    repo: string,
    installationId?: number,
  ): Promise<string | undefined> {
    if (installationId === undefined) return undefined;
    let token: string;
    try {
      token = await this.app.repositoryToken(installationId, repo, {
        metadata: 'read',
      });
    } catch (err) {
      if (err instanceof GitHubApiError && [404, 422].includes(err.status)) {
        throw new ForbiddenException(
          `Struct no longer has access to ${owner}/${repo}. Install the Struct GitHub App on it again.`,
        );
      }
      throw this.unavailable(err);
    }
    try {
      await this.assertAccess(userId, owner, repo, token);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw this.unavailable(err);
    }
    return token;
  }

  // Runs GitHub reads of owner/repo, turning GitHub's errors into ones the user can act on.
  private async readRepository<T>(
    owner: string,
    repo: string,
    token: string | undefined,
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof GitHubApiError && err.status === 404) {
        // Anonymously, GitHub can't tell a private repository from a missing one.
        throw new BadRequestException(
          token
            ? `Couldn't find ${owner}/${repo} on GitHub.`
            : `Couldn't find ${owner}/${repo} on GitHub. If it's private, install the Struct GitHub App on it.`,
        );
      }
      if (err instanceof GitHubApiError && [403, 429].includes(err.status)) {
        this.logger.warn(`GitHub refused ${owner}/${repo}: ${err.message}`);
        throw new ServiceUnavailableException(
          'GitHub is limiting requests from Struct right now. Try again in a few minutes.',
        );
      }
      throw this.unavailable(err);
    }
  }

  private async assertAccess(
    userId: string,
    owner: string,
    repo: string,
    token: string,
  ): Promise<void> {
    const connection = await this.findConnection(userId);
    if (!connection) {
      throw new ForbiddenException(
        `${owner}/${repo} is private. Connect your GitHub account to import it.`,
      );
    }
    try {
      const { permission, user } = await githubRequest<{
        permission: string;
        user: { id: number } | null;
      }>(
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(connection.login)}/permission`,
        token,
      );
      // Matching the ID guards against a renamed login now belonging to someone else.
      if (user?.id === connection.githubUserId && permission !== 'none') return;
    } catch (err) {
      // GitHub answers 404 for accounts with no access at all.
      if (!(err instanceof GitHubApiError && err.status === 404)) throw err;
    }
    throw new ForbiddenException(
      `Your GitHub account @${connection.login} doesn't have access to ${owner}/${repo}.`,
    );
  }

  private async findConnection(
    userId: string,
  ): Promise<GitHubConnectionItem | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: GITHUB_CONNECTION_KEY },
      }),
    );
    return Item as GitHubConnectionItem | undefined;
  }

  private async exchangeCode(code: string): Promise<string> {
    let body: { access_token?: string; error?: string };
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw this.unavailable(err);
    }
    // GitHub reports a used or expired code as 200 with an `error` field.
    if (!body.access_token) {
      throw new BadRequestException(
        "GitHub didn't accept the sign-in. Try connecting again.",
      );
    }
    return body.access_token;
  }

  // `<base64url payload>.<HMAC>`, binding GitHub's redirect to the user who started it.
  signState(userId: string, now = Date.now()): string {
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, exp: now + STATE_TTL_MS }),
    ).toString('base64url');
    return `${payload}.${this.hmac(payload)}`;
  }

  verifyState(state: string, userId: string, now = Date.now()): boolean {
    const [payload, signature] = state.split('.');
    if (!payload || !signature) return false;
    const expected = Buffer.from(this.hmac(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return false;
    }
    try {
      const { sub, exp } = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      ) as { sub: string; exp: number };
      return sub === userId && exp > now;
    } catch {
      return false;
    }
  }

  private hmac(payload: string): string {
    return createHmac('sha256', this.clientSecret!)
      .update(payload)
      .digest('base64url');
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'GitHub integration is not configured on this server.',
      );
    }
  }

  private unavailable(err: unknown) {
    this.logger.error(`GitHub request failed: ${(err as Error).message}`);
    return new ServiceUnavailableException(
      "Couldn't reach GitHub. Try again in a moment.",
    );
  }
}
