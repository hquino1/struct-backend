import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GitHubService } from '../github/github.service.js';
import { ProjectsService } from './projects.service.js';
import type { ProjectItem } from './project.entity.js';

const projectId = '6f1b1f9d-9620-4b80-a8e5-c0cd743a74fc';
const item: ProjectItem = {
  PK: 'USER#u1',
  SK: `PROJECT#${projectId}`,
  name: 'struct',
  repoUrl: 'https://github.com/acme/struct',
  branch: 'main',
  createdAT: '2026-10-14T12:00:00.000Z',
  analysis: { status: 'NOT_STARTED', step: null },
};

const setup = (
  send: (command: { input: any }) => unknown,
  resolveRepository: () => Promise<number | undefined> = async () => undefined,
) => {
  const db = { send: vi.fn(send) };
  const config = { getOrThrow: () => 'projects' } as unknown as ConfigService;
  const github = {
    resolveRepository: vi.fn(resolveRepository),
    resolveBranch: vi.fn(
      async (
        _userId: string,
        _owner: string,
        _repo: string,
        _installationId?: number,
        branch?: string,
      ) => branch || 'main',
    ),
    listBranches: vi.fn(),
  };
  const service = new ProjectsService(
    db as unknown as DynamoDBDocumentClient,
    config,
    github as unknown as GitHubService,
  );
  return { db, github, service };
};

describe('ProjectsService.create', () => {
  it('saves a public repository without an installation', async () => {
    const { db, github, service } = setup(() => ({}));

    const project = await service.create('u1', {
      repoUrl: 'https://github.com/acme/shop.git',
    });

    expect(github.resolveRepository).toHaveBeenCalledWith('u1', 'acme', 'shop');
    expect(project).toMatchObject({ name: 'shop', private: false });
    expect(db.send.mock.calls[0][0].input.Item.installationId).toBeUndefined();
  });

  it("tracks the branch GitHub resolved, the repository's default when none is given", async () => {
    const { db, github, service } = setup(() => ({}));
    github.resolveBranch.mockResolvedValue('master');

    const project = await service.create('u1', {
      repoUrl: 'https://github.com/acme/shop',
    });

    expect(github.resolveBranch).toHaveBeenCalledWith(
      'u1',
      'acme',
      'shop',
      undefined,
      undefined,
    );
    expect(project.branch).toBe('master');
    expect(db.send.mock.calls[0][0].input.Item.branch).toBe('master');
  });

  it('saves the installation that reads a private repository', async () => {
    const { db, service } = setup(
      () => ({}),
      async () => 42,
    );

    const project = await service.create('u1', {
      repoUrl: 'https://github.com/acme/secret',
    });

    expect(project.private).toBe(true);
    expect(db.send.mock.calls[0][0].input.Item.installationId).toBe(42);
  });

  it("saves nothing when the user can't read the repository", async () => {
    const { db, service } = setup(
      () => ({}),
      async () => {
        throw new ForbiddenException('no access');
      },
    );

    await expect(
      service.create('u1', { repoUrl: 'https://github.com/acme/secret' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.send).not.toHaveBeenCalled();
  });
});

describe('ProjectsService.update', () => {
  it('sets only the fields given, trimmed, on an existing project', async () => {
    const { db, service } = setup(() => ({
      Attributes: { ...item, name: 'Renamed' },
    }));

    const project = await service.update('u1', projectId, {
      name: '  Renamed ',
    });

    expect(project.name).toBe('Renamed');
    const { input } = db.send.mock.calls[0][0];
    expect(input.UpdateExpression).toBe('SET #name = :name');
    expect(input.ExpressionAttributeValues).toEqual({ ':name': 'Renamed' });
    expect(input.ConditionExpression).toBe('attribute_exists(SK)');
  });

  it('checks a new branch on GitHub through the project installation before saving it', async () => {
    const { db, github, service } = setup((command) =>
      command.input.UpdateExpression
        ? { Attributes: { ...item, branch: 'dev' } }
        : { Item: { ...item, installationId: 42 } },
    );

    const project = await service.update('u1', projectId, { branch: ' dev ' });

    expect(github.resolveBranch).toHaveBeenCalledWith(
      'u1',
      'acme',
      'struct',
      42,
      'dev',
    );
    expect(project.branch).toBe('dev');
    expect(db.send.mock.calls[1][0].input.ExpressionAttributeValues).toEqual({
      ':branch': 'dev',
    });
  });

  it("saves nothing when the repository doesn't have the branch", async () => {
    const { db, github, service } = setup(() => ({ Item: item }));
    github.resolveBranch.mockRejectedValue(
      new BadRequestException('no branch'),
    );

    await expect(
      service.update('u1', projectId, { branch: 'typo' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.send).toHaveBeenCalledTimes(1);
  });

  it("reports another user's or a missing project as not found", async () => {
    const { service } = setup(() => {
      throw new ConditionalCheckFailedException({
        message: 'failed',
        $metadata: {},
      });
    });

    await expect(
      service.update('u1', projectId, { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports a missing project as not found before asking GitHub about a branch', async () => {
    const { github, service } = setup(() => ({}));

    await expect(
      service.update('u1', projectId, { branch: 'dev' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(github.resolveBranch).not.toHaveBeenCalled();
  });
});

describe('ProjectsService.listBranches', () => {
  it("lists the project repository's branches through its installation", async () => {
    const { github, service } = setup(() => ({
      Item: { ...item, installationId: 42 },
    }));
    const branches = {
      defaultBranch: 'main',
      branches: ['main'],
      truncated: false,
    };
    github.listBranches.mockResolvedValue(branches);

    await expect(service.listBranches('u1', projectId)).resolves.toBe(branches);
    expect(github.listBranches).toHaveBeenCalledWith(
      'u1',
      'acme',
      'struct',
      42,
    );
  });
});

describe('ProjectsService.remove', () => {
  it('deletes the project, its graph, and every view in one transaction', async () => {
    const { db, service } = setup(() => ({}));

    await service.remove('u1', projectId);

    const { input } = db.send.mock.calls[0][0];
    const keys = input.TransactItems.map(
      (t: { Delete: { Key: { SK: string } } }) => t.Delete.Key.SK,
    );
    expect(keys[0]).toBe(`PROJECT#${projectId}`);
    expect(keys).toContain(`GRAPH#${projectId}`);
    expect(keys).toContain(`VIEW#${projectId}#ci-cd`);
    expect(input.TransactItems[0].Delete.ConditionExpression).toBe(
      'attribute_exists(SK)',
    );
  });

  it('reports a missing project as not found', async () => {
    const { service } = setup(() => {
      throw new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      });
    });

    await expect(service.remove('u1', projectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
