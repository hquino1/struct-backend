import {
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
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
import {
  projectKey,
  userKey,
  type ProjectItem,
} from '../projects/project.entity.js';
import { AnalysisLauncher } from './analysis-launcher.js';
import {
  graphKey,
  HEARTBEAT_TIMEOUT_MS,
  viewKey,
  toAnalysis,
  type Analysis,
  type GraphItem,
  type ProjectAnalysis,
  type SavedGraph,
  type SavedView,
  type ViewItem,
} from './analysis.entity.js';
import type { ViewId } from '../analyzer/views/view-graph.js';

@Injectable()
export class AnalysesService {
  private readonly logger = new Logger(AnalysesService.name);
  private readonly tableName: string;

  constructor(
    @Inject(DYNAMODB_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly launcher: AnalysisLauncher,
    config: ConfigService,
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
  }

  async start(userId: string, projectId: string): Promise<Analysis> {
    const now = new Date();
    const analysis: ProjectAnalysis = {
      status: 'QUEUED',
      step: 'clone',
      analysisId: randomUUID(),
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
    };

    let project: ProjectItem;
    try {
      // Updating under the caller's key doubles as the ownership check, and the condition
      // allows one run per project at a time unless the current one stopped responding.
      const result = await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userKey(userId), SK: projectKey(projectId) },
          UpdateExpression: 'SET #analysis = :analysis',
          ConditionExpression:
            'attribute_exists(SK) AND (attribute_not_exists(#analysis.#status) OR NOT (#analysis.#status IN (:queued, :running)) OR #analysis.#heartbeatAt < :staleBefore)',
          ExpressionAttributeNames: {
            '#analysis': 'analysis',
            '#status': 'status',
            '#heartbeatAt': 'heartbeatAt',
          },
          ExpressionAttributeValues: {
            ':analysis': analysis,
            ':queued': 'QUEUED',
            ':running': 'RUNNING',
            ':staleBefore': new Date(
              now.getTime() - HEARTBEAT_TIMEOUT_MS,
            ).toISOString(),
          },
          ReturnValues: 'ALL_NEW',
          // Tells "no such project" (no item) apart from "already running" (item).
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      project = result.Attributes as ProjectItem;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        if (!err.Item) throw new NotFoundException('Project not found');
        throw new ConflictException(
          'An analysis is already running for this project',
        );
      }
      throw err;
    }

    const analysisId = analysis.analysisId!;
    try {
      await this.launcher.launch({
        userId,
        projectId,
        analysisId,
        repoUrl: project.repoUrl,
        branch: project.branch,
      });
    } catch (err) {
      this.logger.error(
        `Failed to launch analysis ${analysisId}: ${(err as Error).message}`,
      );
      await this.markLaunchFailed(userId, projectId, analysisId);
      throw new ServiceUnavailableException(
        "Couldn't start the analysis. Try again in a moment.",
      );
    }

    return toAnalysis(projectId, analysis)!;
  }

  async findLatest(
    userId: string,
    projectId: string,
  ): Promise<Analysis | null> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: projectKey(projectId) },
        ProjectionExpression: '#analysis',
        ExpressionAttributeNames: { '#analysis': 'analysis' },
      }),
    );
    if (!Item) throw new NotFoundException('Project not found');
    return toAnalysis(projectId, (Item as ProjectItem).analysis);
  }

  // The latest completed run's graph. The key is under the caller's PK, so another user's
  // project reads as missing.
  async findGraph(userId: string, projectId: string): Promise<SavedGraph> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: graphKey(projectId) },
      }),
    );
    if (!Item) {
      throw new NotFoundException(
        'This project has no architecture graph yet. Run an analysis first.',
      );
    }
    const { analysisId, graph } = Item as GraphItem;
    return { projectId, analysisId, ...graph };
  }

  // One explore view from the latest completed run.
  async findView(
    userId: string,
    projectId: string,
    view: ViewId,
  ): Promise<SavedView> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userKey(userId), SK: viewKey(projectId, view) },
      }),
    );
    if (!Item) {
      throw new NotFoundException(
        "This view wasn't built for this project's latest analysis.",
      );
    }
    const { analysisId, graph } = Item as ViewItem;
    return { projectId, analysisId, view, ...graph };
  }

  private async markLaunchFailed(
    userId: string,
    projectId: string,
    analysisId: string,
  ) {
    await this.db
      .send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userKey(userId), SK: projectKey(projectId) },
          UpdateExpression:
            'SET #analysis.#status = :failed, #analysis.#error = :error, #analysis.finishedAt = :now',
          ConditionExpression: '#analysis.analysisId = :analysisId',
          ExpressionAttributeNames: {
            '#analysis': 'analysis',
            '#status': 'status',
            '#error': 'error',
          },
          ExpressionAttributeValues: {
            ':failed': 'FAILED',
            ':error': "The analysis couldn't be started.",
            ':now': new Date().toISOString(),
            ':analysisId': analysisId,
          },
        }),
      )
      // Best effort: the run is reported as failed once its heartbeat goes stale anyway.
      .catch(() => undefined);
  }
}
