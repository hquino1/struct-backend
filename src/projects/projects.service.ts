import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { graphKey, NOT_STARTED, viewKey } from '../analyses/analysis.entity.js';
import { docPrefix, filesKey } from '../docs/docs.entity.js';
import { VIEW_IDS } from '../analyzer/views/view-graph.js';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
import type { RepositoryBranches } from '../github/github.entity.js';
import { GitHubService } from '../github/github.service.js';
import { CreateProjectDto, GITHUB_REPO_URL } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import {
  projectKey,
  toProject,
  userKey,
  type Project,
  type ProjectItem,
} from './project.entity.js';

@Injectable()
export class ProjectsService {
  private readonly tableName: string;

  constructor(
    @Inject(DYNAMODB_CLIENT) private readonly db: DynamoDBDocumentClient,
    config: ConfigService,
    private readonly github: GitHubService,
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
  }

  async create(userId: string, dto: CreateProjectDto): Promise<Project> {
    // The DTO already validated the URL, so the match always succeeds.
    const [, repoOwner, repoName] = GITHUB_REPO_URL.exec(dto.repoUrl)!;
    // Throws if the repository is private and the user can't read it on GitHub.
    const installationId = await this.github.resolveRepository(
      userId,
      repoOwner,
      repoName,
    );
    // Throws if the repository has no such branch.
    const branch = await this.github.resolveBranch(
      userId,
      repoOwner,
      repoName,
      installationId,
      dto.branch?.trim(),
    );
    const item: ProjectItem = {
      PK: userKey(userId),
      SK: projectKey(randomUUID()),
      name: dto.name?.trim() || repoName,
      repoUrl: `https://github.com/${repoOwner}/${repoName}`,
      branch,
      createdAT: new Date().toISOString(),
      installationId,
      // Status and step are filled in once the first analysis starts.
      analysis: NOT_STARTED,
    };

    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(SK)',
      }),
    );
    return toProject(item);
  }

  async findAllForUser(userId: string): Promise<Project[]> {
    const items: ProjectItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: {
            ':pk': userKey(userId),
            ':sk': projectKey(''),
          },
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((page.Items ?? []) as ProjectItem[]));
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    // Newest first; ISO timestamps sort lexicographically.
    return items
      .map(toProject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findOne(userId: string, projectId: string): Promise<Project> {
    return toProject(await this.findItem(userId, projectId));
  }

  // The branches the project could track, for the branch picker.
  async listBranches(
    userId: string,
    projectId: string,
  ): Promise<RepositoryBranches> {
    const { repoUrl, installationId } = await this.findItem(userId, projectId);
    const [, owner, repo] = GITHUB_REPO_URL.exec(repoUrl)!;
    return this.github.listBranches(userId, owner, repo, installationId);
  }

  async update(
    userId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<Project> {
    let branch: string | undefined;
    if (dto.branch !== undefined) {
      // Throws if the repository has no such branch, so a typo fails here, not at the clone.
      const { repoUrl, installationId } = await this.findItem(
        userId,
        projectId,
      );
      const [, owner, repo] = GITHUB_REPO_URL.exec(repoUrl)!;
      branch = await this.github.resolveBranch(
        userId,
        owner,
        repo,
        installationId,
        dto.branch.trim(),
      );
    }
    const fields = {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(branch !== undefined && { branch }),
    };
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.findOne(userId, projectId);

    try {
      const { Attributes } = await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userKey(userId), SK: projectKey(projectId) },
          UpdateExpression: `SET ${keys.map((k) => `#${k} = :${k}`).join(', ')}`,
          // Without it, updating a missing key would create a half-formed project.
          ConditionExpression: 'attribute_exists(SK)',
          ExpressionAttributeNames: Object.fromEntries(
            keys.map((k) => [`#${k}`, k]),
          ),
          ExpressionAttributeValues: Object.fromEntries(
            Object.entries(fields).map(([k, v]) => [`:${k}`, v]),
          ),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toProject(Attributes as ProjectItem);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }

  // A project has at most MAX_DOC_FILES docs, plus any kept from files that later failed.
  private async docKeys(pk: string, projectId: string) {
    const keys: string[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {
            ':pk': pk,
            ':prefix': docPrefix(projectId),
          },
          ProjectionExpression: 'SK',
          ExclusiveStartKey,
        }),
      );
      keys.push(...(page.Items ?? []).map((item) => item.SK as string));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return keys;
  }

  private async findItem(
    userId: string,
    projectId: string,
  ): Promise<ProjectItem> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: projectKey(projectId) },
      }),
    );
    if (!Item) throw new NotFoundException('Project not found');
    return Item as ProjectItem;
  }

  // Removes the project with its saved graph, views, file list, and docs in one
  // transaction. A run still in progress can't bring them back: every worker write is
  // conditioned on the project's current analysisId or docs runId, which no longer exist,
  // so the worker stops at its next write.
  async remove(userId: string, projectId: string): Promise<void> {
    const pk = userKey(userId);
    const derived = [
      graphKey(projectId),
      filesKey(projectId),
      ...VIEW_IDS.map((view) => viewKey(projectId, view)),
      ...(await this.docKeys(pk, projectId)),
    ];
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.tableName,
                Key: { PK: pk, SK: projectKey(projectId) },
                ConditionExpression: 'attribute_exists(SK)',
              },
            },
            ...derived.map((sk) => ({
              Delete: { TableName: this.tableName, Key: { PK: pk, SK: sk } },
            })),
          ],
        }),
      );
    } catch (err) {
      if (
        err instanceof TransactionCanceledException &&
        err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
      ) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }
}
