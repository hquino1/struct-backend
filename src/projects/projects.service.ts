import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { NOT_STARTED } from '../analyses/analysis.entity.js';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
import { CreateProjectDto, GITHUB_REPO_URL } from './dto/create-project.dto.js';
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
}
