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
import { VIEW_IDS } from '../analyzer/views/view-graph.js';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
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
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
  }

  async create(userId: string, dto: CreateProjectDto): Promise<Project> {
    // The DTO already validated the URL, so the match always succeeds.
    const [, repoOwner, repoName] = GITHUB_REPO_URL.exec(dto.repoUrl)!;
    const item: ProjectItem = {
      PK: userKey(userId),
      SK: projectKey(randomUUID()),
      name: dto.name?.trim() || repoName,
      repoUrl: `https://github.com/${repoOwner}/${repoName}`,
      branch: dto.branch?.trim() || 'main',
      createdAT: new Date().toISOString(),
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
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: projectKey(projectId) },
      }),
    );
    if (!Item) throw new NotFoundException('Project not found');
    return toProject(Item as ProjectItem);
  }

  async update(
    userId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<Project> {
    const fields = {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.branch !== undefined && { branch: dto.branch.trim() }),
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

  // Removes the project with its saved graph and views in one transaction. A run still in
  // progress can't bring them back: every worker write is conditioned on the project's
  // current analysisId, which no longer exists, so the worker stops at its next write.
  async remove(userId: string, projectId: string): Promise<void> {
    const pk = userKey(userId);
    const derived = [
      graphKey(projectId),
      ...VIEW_IDS.map((view) => viewKey(projectId, view)),
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
