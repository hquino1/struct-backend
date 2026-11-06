import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GitHubAppService } from './github-app.service.js';
import { GitHubService } from './github.service.js';
import type { GitHubConnectionItem } from './github.entity.js';

const connection: GitHubConnectionItem = {
  PK: 'USER#u1',
  SK: 'GITHUB',
  githubUserId: 7,
  login: 'octo',
  connectedAt: '2026-11-02T12:00:00.000Z',
};

const settings: Record<string, string> = {
  DYNAMODB_PROJECTS_TABLE: 'projects',
  GITHUB_APP_SLUG: 'struct-dev',
  GITHUB_CLIENT_ID: 'Iv1.client',
  GITHUB_CLIENT_SECRET: 'secret',
};

// GitHub API responses by path; a number answers with that error status.
const stubGitHub = (responses: Record<string, unknown>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const response = responses[new URL(url).pathname];
      if (response === undefined) throw new Error(`Unexpected fetch ${url}`);
      return typeof response === 'number'
        ? new Response('{}', { status: response })
        : Response.json(response);
    }),
  );

const setup = ({ connected = true } = {}) => {
  const item = connected ? connection : undefined;
  const db = { send: vi.fn(async () => ({ Item: item })) };
  const app = {
    enabled: true,
    findInstallation: vi.fn(async () => 42 as number | undefined),
    repositoryToken: vi.fn(async () => 'installation-token'),
  };
  const config = {
    get: (key: string) => settings[key],
    getOrThrow: (key: string) => settings[key],
  } as unknown as ConfigService;
  const service = new GitHubService(
    db as unknown as DynamoDBDocumentClient,
    app as unknown as GitHubAppService,
    config,
  );
  return { db, app, service };
};

afterEach(() => vi.unstubAllGlobals());

describe('GitHubService state', () => {
  it('accepts its own state for the same user before it expires', () => {
    const { service } = setup();
    const state = service.signState('u1', 0);

    expect(service.verifyState(state, 'u1', 1000)).toBe(true);
    expect(service.verifyState(state, 'u2', 1000)).toBe(false);
    expect(service.verifyState(state, 'u1', 2 * 60 * 60 * 1000)).toBe(false);
  });

  it('rejects a state whose payload was changed', () => {
    const { service } = setup();
    const [, signature] = service.signState('u1').split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u2', exp: Date.now() + 60_000 }),
    ).toString('base64url');

    expect(service.verifyState(`${forged}.${signature}`, 'u2')).toBe(false);
  });
});

describe('GitHubService.resolveRepository', () => {
  it('reads repositories the app is not installed on anonymously', async () => {
    const { app, service } = setup();
    app.findInstallation.mockResolvedValue(undefined);

    await expect(
      service.resolveRepository('u1', 'acme', 'shop'),
    ).resolves.toBeUndefined();
  });

  it('reads public repositories anonymously even when the app is installed', async () => {
    const { service } = setup();
    stubGitHub({ '/repos/acme/shop': { private: false } });

    await expect(
      service.resolveRepository('u1', 'acme', 'shop'),
    ).resolves.toBeUndefined();
  });

  it('uses the installation when the connected account can read the private repository', async () => {
    const { service } = setup();
    stubGitHub({
      '/repos/acme/secret': { private: true },
      '/repos/acme/secret/collaborators/octo/permission': {
        permission: 'read',
        user: { id: 7 },
      },
    });

    await expect(
      service.resolveRepository('u1', 'acme', 'secret'),
    ).resolves.toBe(42);
  });

  it('refuses a private repository until GitHub is connected', async () => {
    const { service } = setup({ connected: false });
    stubGitHub({ '/repos/acme/secret': { private: true } });

    await expect(
      service.resolveRepository('u1', 'acme', 'secret'),
    ).rejects.toThrow(/Connect your GitHub account/);
  });

  it('refuses a private repository the connected account has no access to', async () => {
    const { service } = setup();
    stubGitHub({
      '/repos/acme/secret': { private: true },
      '/repos/acme/secret/collaborators/octo/permission': 404,
    });

    await expect(
      service.resolveRepository('u1', 'acme', 'secret'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GitHubService.assertCanRead', () => {
  it('refuses when the login now belongs to a different GitHub account', async () => {
    const { service } = setup();
    stubGitHub({
      '/repos/acme/secret/collaborators/octo/permission': {
        permission: 'admin',
        user: { id: 99 },
      },
    });

    await expect(
      service.assertCanRead('u1', 'acme', 'secret', 42),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('explains when the app was removed from the repository', async () => {
    const { app, service } = setup();
    const { GitHubApiError } = await import('./github-app.service.js');
    app.repositoryToken.mockRejectedValue(new GitHubApiError(422, 'gone'));

    await expect(
      service.assertCanRead('u1', 'acme', 'secret', 42),
    ).rejects.toThrow(/no longer has access/);
  });
});

describe('GitHubService.listBranches', () => {
  it('lists every page of a public repository anonymously', async () => {
    const { app, service } = setup();
    const names = Array.from({ length: 130 }, (_, i) => `b${i}`);
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const { pathname, searchParams } = new URL(url);
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      if (pathname === '/repos/acme/shop') {
        return Response.json({ default_branch: 'b7' });
      }
      const page = Number(searchParams.get('page'));
      return Response.json(
        names.slice((page - 1) * 100, page * 100).map((name) => ({ name })),
      );
    });
    vi.stubGlobal('fetch', fetch);

    await expect(service.listBranches('u1', 'acme', 'shop')).resolves.toEqual({
      defaultBranch: 'b7',
      branches: names,
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(app.repositoryToken).not.toHaveBeenCalled();
  });

  it('checks access before listing a private repository', async () => {
    const { service } = setup();
    stubGitHub({
      '/repos/acme/secret/collaborators/octo/permission': 404,
    });

    await expect(
      service.listBranches('u1', 'acme', 'secret', 42),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('points to the GitHub App when a repository is missing anonymously', async () => {
    const { service } = setup();
    stubGitHub({ '/repos/acme/hidden': 404 });

    await expect(service.listBranches('u1', 'acme', 'hidden')).rejects.toThrow(
      /install the Struct GitHub App/,
    );
  });

  it("explains GitHub's rate limit", async () => {
    const { service } = setup();
    stubGitHub({ '/repos/acme/shop': 403 });

    await expect(service.listBranches('u1', 'acme', 'shop')).rejects.toThrow(
      /limiting requests/,
    );
  });
});

describe('GitHubService.resolveBranch', () => {
  it("falls back to the repository's default branch", async () => {
    const { service } = setup();
    stubGitHub({ '/repos/acme/shop': { default_branch: 'master' } });

    await expect(
      service.resolveBranch('u1', 'acme', 'shop', undefined),
    ).resolves.toBe('master');
  });

  it('accepts a branch with a slash in its name', async () => {
    const { service } = setup();
    stubGitHub({
      '/repos/acme/shop': { default_branch: 'main' },
      '/repos/acme/shop/branches/feature%2Fmap': { name: 'feature/map' },
    });

    await expect(
      service.resolveBranch('u1', 'acme', 'shop', undefined, 'feature/map'),
    ).resolves.toBe('feature/map');
  });

  it('rejects a branch the repository does not have', async () => {
    const { service } = setup();
    stubGitHub({
      '/repos/acme/shop': { default_branch: 'main' },
      '/repos/acme/shop/branches/typo': 404,
    });

    await expect(
      service.resolveBranch('u1', 'acme', 'shop', undefined, 'typo'),
    ).rejects.toThrow('acme/shop has no branch named "typo".');
  });
});
