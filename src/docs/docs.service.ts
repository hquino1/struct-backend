import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { AnalysisLauncher } from '../analyses/analysis-launcher.js';
import { toAnalysis } from '../analyses/analysis.entity.js';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
import { GitHubService } from '../github/github.service.js';
import { GITHUB_REPO_URL } from '../projects/dto/create-project.dto.js';
import {
  projectKey,
  userKey,
  type ProjectItem,
} from '../projects/project.entity.js';
import {
  docPrefix,
  filesKey,
  isDocsActive,
  isDocsStale,
  toDocsState,
  unpackPaths,
  type DocItem,
  type DocsState,
  type DocSuggestion,
  type FileDoc,
  type FilesItem,
  type ProjectDocs,
} from './docs.entity.js';
import type { UpdateDocsDto } from './dto/update-docs.dto.js';

// API side: reads a project's docs and starts docs runs when the user changes which files
// to document. Analyses start their own docs run when they finish.
@Injectable()
export class DocsService {
  private readonly logger = new Logger(DocsService.name);
  private readonly tableName: string;

  constructor(
    @Inject(DYNAMODB_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly launcher: AnalysisLauncher,
    private readonly github: GitHubService,
    config: ConfigService,
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
  }

  async findDocs(userId: string, projectId: string): Promise<DocsState> {
    const [project, files, docs] = await Promise.all([
      this.project(userId, projectId),
      this.files(userId, projectId, 'suggestions'),
      this.savedDocs(userId, projectId),
    ]);
    return toDocsState(project.docs, files?.suggestions ?? [], docs);
  }

  // Every documentable file of the latest completed analysis, for the file picker.
  async findFiles(
    userId: string,
    projectId: string,
  ): Promise<{
    commit: string;
    paths: string[];
    suggestions: DocSuggestion[];
  }> {
    const files = await this.files(userId, projectId);
    if (!files) {
      throw new NotFoundException(
        'This project has no file list yet. Re-analyze it first.',
      );
    }
    return {
      commit: files.commit,
      paths: unpackPaths(files.paths),
      suggestions: files.suggestions,
    };
  }

  // Saves how files are picked and documents them now, at the analyzed commit.
  async update(
    userId: string,
    projectId: string,
    dto: UpdateDocsDto,
  ): Promise<DocsState> {
    const project = await this.project(userId, projectId);
    const analysis = toAnalysis(projectId, project.analysis);
    if (analysis?.status !== 'COMPLETE' || !analysis.commit) {
      throw new ConflictException(
        analysis && ['QUEUED', 'RUNNING'].includes(analysis.status)
          ? 'Wait for the analysis to finish, then pick files to document.'
          : 'Analyze this project before documenting its files.',
      );
    }
    const previous = project.docs;
    if (isDocsActive(previous) && !isDocsStale(previous)) {
      throw new ConflictException(
        'Docs are already being written for this project. Try again when they finish.',
      );
    }

    const files = await this.files(userId, projectId);
    if (!files) {
      throw new ConflictException(
        'Re-analyze this project to document its files.',
      );
    }
    let selection: string[];
    if (dto.mode === 'manual') {
      const available = new Set(unpackPaths(files.paths));
      const unknown = dto.paths!.filter((p) => !available.has(p));
      if (unknown.length) {
        throw new BadRequestException(
          `These files can't be documented: ${unknown.slice(0, 5).join(', ')}`,
        );
      }
      selection = dto.paths!;
    } else {
      selection = files.suggestions.map((s) => s.path);
    }

    // Private repositories are re-checked on GitHub before the worker clones them.
    if (project.installationId !== undefined) {
      const [, owner, repo] = GITHUB_REPO_URL.exec(project.repoUrl)!;
      await this.github.assertCanRead(
        userId,
        owner,
        repo,
        project.installationId,
      );
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    const docs: ProjectDocs = {
      mode: dto.mode,
      ...(dto.mode === 'manual' && { selection }),
      status: 'QUEUED',
      runId,
      startedAt: now,
      heartbeatAt: now,
      commit: analysis.commit,
      total: selection.length,
      done: 0,
      failed: [],
    };
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userKey(userId), SK: projectKey(projectId) },
          UpdateExpression: 'SET #docs = :docs',
          // Nothing changed since the checks above: same analysis, same docs run.
          ConditionExpression: `#analysis.analysisId = :analysisId AND #analysis.#status = :complete AND ${
            previous?.runId
              ? '#docs.runId = :previousRunId'
              : 'attribute_not_exists(#docs.runId)'
          }`,
          ExpressionAttributeNames: {
            '#analysis': 'analysis',
            '#status': 'status',
            '#docs': 'docs',
          },
          ExpressionAttributeValues: {
            ':docs': docs,
            ':analysisId': analysis.analysisId,
            ':complete': 'COMPLETE',
            ...(previous?.runId && { ':previousRunId': previous.runId }),
          },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictException(
          'This project changed while saving. Reload and try again.',
        );
      }
      throw err;
    }

    try {
      await this.launcher.launch({
        kind: 'docs',
        userId,
        projectId,
        analysisId: analysis.analysisId,
        docsRunId: runId,
        commit: analysis.commit,
        repoUrl: project.repoUrl,
        branch: project.branch,
        installationId: project.installationId,
      });
    } catch (err) {
      this.logger.error(
        `Failed to launch docs run ${runId}: ${(err as Error).message}`,
      );
      await this.markLaunchFailed(userId, projectId, runId);
      throw new ServiceUnavailableException(
        "Couldn't start writing the docs. Try again in a moment.",
      );
    }
    return this.findDocs(userId, projectId);
  }

  private async project(userId: string, projectId: string) {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: projectKey(projectId) },
      }),
    );
    if (!Item) throw new NotFoundException('Project not found');
    return Item as ProjectItem;
  }

  private async files(userId: string, projectId: string, projection?: string) {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: filesKey(projectId) },
        ...(projection && { ProjectionExpression: projection }),
      }),
    );
    return Item as FilesItem | undefined;
  }

  private async savedDocs(userId: string, projectId: string) {
    const docs: FileDoc[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {
            ':pk': userKey(userId),
            ':prefix': docPrefix(projectId),
          },
          ExclusiveStartKey,
        }),
      );
      docs.push(...((page.Items ?? []) as DocItem[]).map((item) => item.doc));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return docs;
  }

  private async markLaunchFailed(
    userId: string,
    projectId: string,
    runId: string,
  ) {
    await this.db
      .send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userKey(userId), SK: projectKey(projectId) },
          UpdateExpression:
            'SET #docs.#status = :failed, #docs.#error = :error, #docs.finishedAt = :now',
          ConditionExpression: '#docs.runId = :runId',
          ExpressionAttributeNames: {
            '#docs': 'docs',
            '#status': 'status',
            '#error': 'error',
          },
          ExpressionAttributeValues: {
            ':failed': 'FAILED',
            ':error': "Writing the docs couldn't be started.",
            ':now': new Date().toISOString(),
            ':runId': runId,
          },
        }),
      )
      // Best effort: the run is reported as failed once its heartbeat goes stale anyway.
      .catch(() => undefined);
  }
}
