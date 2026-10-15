import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisJob } from '../analyses/analysis-launcher.js';
import {
  graphKey,
  type AnalysisStep,
  type GraphItem,
  type ProjectAnalysis,
} from '../analyses/analysis.entity.js';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
import { projectKey, userKey } from '../projects/project.entity.js';
import {
  ComponentsResult,
  ConnectionsResult,
  InsightsResult,
  type ArchitectureGraph,
  type Component,
} from './architecture.js';
import { LlmService } from './llm.service.js';
import { INSIGHTS_SYSTEM, MAP_SYSTEM, TRACE_SYSTEM } from './prompts.js';
import { buildMapDigest, buildTraceDigest } from './repo-digest.js';
import {
  AnalysisError,
  cloneRepository,
  listRepositoryFiles,
  scanRepository,
} from './repository.js';

// Well inside HEARTBEAT_TIMEOUT_MS, so a slow step never looks like a dead task.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Keeps the graph comfortably under DynamoDB's 400 KB item limit.
const MAX_GRAPH_BYTES = 350_000;

// Thrown when a newer run has replaced this one; the old worker just stops.
class SupersededError extends Error {}

@Injectable()
export class AnalyzerService {
  private readonly logger = new Logger(AnalyzerService.name);
  private readonly tableName: string;

  constructor(
    @Inject(DYNAMODB_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly llm: LlmService,
    config: ConfigService,
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
  }

  // Runs the whole pipeline, recording progress on the analysis item as it goes.
  // Resolves false if the run failed.
  async run(job: AnalysisJob): Promise<boolean> {
    const workDir = await mkdtemp(join(tmpdir(), 'struct-analysis-'));
    const heartbeat = setInterval(() => {
      this.update(job, {}).catch((err: Error) =>
        this.logger.warn(`Heartbeat failed: ${err.message}`),
      );
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const repoDir = join(workDir, 'repo');
      await this.setStep(job, 'clone');
      const commit = await cloneRepository(job.repoUrl, job.branch, repoDir);

      await this.setStep(job, 'detect', { commit });
      const paths = await listRepositoryFiles(repoDir);
      const stats = scanRepository(paths);

      await this.setStep(job, 'map', { stats });
      const components = await this.mapComponents(repoDir, paths);

      await this.setStep(job, 'trace');
      const { digest, fileCounts } = await buildTraceDigest(
        repoDir,
        paths,
        components,
      );
      const connections = await this.traceConnections(components, digest);

      await this.setStep(job, 'insights');
      const insights = await this.generateInsights(components, connections);

      await this.complete(job, {
        components: components.map((c) => ({
          ...c,
          files: fileCounts[c.id] ?? 0,
        })),
        connections,
        insights,
      });
      this.logger.log(`Analysis ${job.analysisId} complete`);
      return true;
    } catch (err) {
      if (err instanceof SupersededError) {
        this.logger.warn(
          `Analysis ${job.analysisId} was replaced by a newer run`,
        );
        return true;
      }
      this.logger.error(
        `Analysis ${job.analysisId} failed: ${(err as Error).stack ?? String(err)}`,
      );
      await this.update(job, {
        status: 'FAILED',
        finishedAt: new Date().toISOString(),
        error:
          err instanceof AnalysisError
            ? err.message
            : 'The analysis failed unexpectedly. Try running it again.',
      }).catch(() => undefined);
      return false;
    } finally {
      clearInterval(heartbeat);
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async mapComponents(repoDir: string, paths: string[]) {
    const { components } = await this.llm.callTool({
      system: MAP_SYSTEM,
      prompt: await buildMapDigest(repoDir, paths),
      tool: {
        name: 'record_components',
        description: "Record the system's main components.",
        schema: ComponentsResult,
      },
      effort: 'high',
    });
    // Ids key every later step, so duplicates would merge two components.
    const unique = [...new Map(components.map((c) => [c.id, c])).values()];
    if (!unique.length) {
      throw new AnalysisError(
        "The AI model couldn't identify any components in this repository.",
      );
    }
    return unique;
  }

  private async traceConnections(components: Component[], digest: string) {
    const { connections } = await this.llm.callTool({
      system: TRACE_SYSTEM,
      prompt: digest,
      tool: {
        name: 'record_connections',
        description: 'Record the connections between components.',
        schema: ConnectionsResult,
      },
      effort: 'high',
    });
    // Drop edges to unknown components, self-loops, and repeats of the same pair.
    const ids = new Set(components.map((c) => c.id));
    const seen = new Set<string>();
    return connections.filter((c) => {
      const pair = `${c.from}->${c.to}`;
      const valid =
        ids.has(c.from) && ids.has(c.to) && c.from !== c.to && !seen.has(pair);
      seen.add(pair);
      return valid;
    });
  }

  private async generateInsights(
    components: Component[],
    connections: ArchitectureGraph['connections'],
  ) {
    const graph = {
      components: components.map(({ id, name, type, tech, description }) => ({
        id,
        name,
        type,
        tech,
        description,
      })),
      connections,
    };
    const { insights } = await this.llm.callTool({
      system: INSIGHTS_SYSTEM,
      prompt: JSON.stringify(graph, null, 2),
      tool: {
        name: 'record_insights',
        description: 'Record insights about the architecture.',
        schema: InsightsResult,
      },
      effort: 'medium',
    });
    const ids = new Set(components.map((c) => c.id));
    return insights.map((insight) => ({
      ...insight,
      componentIds: insight.componentIds.filter((id) => ids.has(id)),
    }));
  }

  // Saves the graph and marks the run complete in one transaction, so a run that a newer
  // one has replaced can't overwrite the newer graph.
  private async complete(job: AnalysisJob, graph: ArchitectureGraph) {
    const item: GraphItem = {
      PK: userKey(job.userId),
      SK: graphKey(job.projectId),
      analysisId: job.analysisId,
      graph,
    };
    if (Buffer.byteLength(JSON.stringify(item)) > MAX_GRAPH_BYTES) {
      throw new AnalysisError(
        'The architecture map for this repository is too large to save.',
      );
    }
    const now = new Date().toISOString();
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: item } },
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  PK: userKey(job.userId),
                  SK: projectKey(job.projectId),
                },
                UpdateExpression:
                  'SET #analysis.#status = :complete, #analysis.finishedAt = :now, #analysis.heartbeatAt = :now',
                ConditionExpression: '#analysis.analysisId = :analysisId',
                ExpressionAttributeNames: {
                  '#analysis': 'analysis',
                  '#status': 'status',
                },
                ExpressionAttributeValues: {
                  ':complete': 'COMPLETE',
                  ':now': now,
                  ':analysisId': job.analysisId,
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (
        err instanceof TransactionCanceledException &&
        err.CancellationReasons?.some(
          (r) => r.Code === 'ConditionalCheckFailed',
        )
      ) {
        throw new SupersededError();
      }
      throw err;
    }
  }

  private setStep(
    job: AnalysisJob,
    step: AnalysisStep,
    extra: Partial<ProjectAnalysis> = {},
  ) {
    this.logger.log(`Analysis ${job.analysisId}: ${step}`);
    return this.update(job, { ...extra, status: 'RUNNING', step });
  }

  // Sets fields of the project's `analysis` attribute and bumps the heartbeat, as long as
  // this run is still the project's current analysis.
  private async update(job: AnalysisJob, fields: Partial<ProjectAnalysis>) {
    const values: Record<string, unknown> = {
      ...fields,
      heartbeatAt: new Date().toISOString(),
    };
    const keys = Object.keys(values);
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userKey(job.userId), SK: projectKey(job.projectId) },
          UpdateExpression: `SET ${keys.map((k) => `#analysis.#${k} = :${k}`).join(', ')}`,
          ConditionExpression: '#analysis.#analysisId = :analysisId',
          ExpressionAttributeNames: Object.fromEntries(
            ['analysis', ...keys, 'analysisId'].map((k) => [`#${k}`, k]),
          ),
          ExpressionAttributeValues: {
            ...Object.fromEntries(keys.map((k) => [`:${k}`, values[k]])),
            ':analysisId': job.analysisId,
          },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new SupersededError();
      }
      throw err;
    }
  }
}
