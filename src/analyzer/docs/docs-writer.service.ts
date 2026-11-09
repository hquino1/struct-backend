import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { DYNAMODB_CLIENT } from '../../dynamodb/dynamodb.constants.js';
import {
  docKey,
  docPrefix,
  type DocItem,
  type FileDoc,
} from '../../docs/docs.entity.js';
import { projectKey, userKey } from '../../projects/project.entity.js';
import { DocResult, type Component } from '../architecture.js';
import { LlmService } from '../llm.service.js';
import { DOC_SYSTEM } from '../prompts.js';
import { componentLocator, readText } from '../repo-digest.js';
import { AnalysisError } from '../repository.js';
import type { ViewGraph } from '../views/view-graph.js';
import { endpointsByFile, type ImportGraph } from './suggest.js';

// Files are hashed whole up to this size; larger ones aren't documented at all.
const MAX_FILE_BYTES = 1_000_000;
// What the model reads of each file (~15K tokens); the doc says when a file was cut.
const MAX_DOC_CHARS = 60_000;
const MAX_LISTED_RELATIONS = 15;
const CONCURRENCY = 4;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface DocsRun {
  userId: string;
  projectId: string;
  runId: string;
  commit: string;
  repoDir: string;
  selection: string[];
  components: Component[];
  api?: ViewGraph;
  imports: ImportGraph;
}

// Thrown when a newer docs run (or a deleted project) has replaced this one.
export class DocsSupersededError extends Error {}

// Worker side: writes the docs for a selection of files. Each file is documented by one
// model call, unless it is unchanged since its saved doc.
@Injectable()
export class DocsWriter {
  private readonly logger = new Logger(DocsWriter.name);
  private readonly tableName: string;

  constructor(
    @Inject(DYNAMODB_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly llm: LlmService,
    config: ConfigService,
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
  }

  // The run must already be the project's current docs run (status QUEUED or RUNNING).
  async write(run: DocsRun): Promise<void> {
    await this.update(run, {
      status: 'RUNNING',
      total: run.selection.length,
      done: 0,
    });
    const heartbeat = setInterval(() => {
      this.update(run, {}).catch((err: Error) =>
        this.logger.warn(`Docs heartbeat failed: ${err.message}`),
      );
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const saved = await this.savedDocs(run);
      const context = this.context(run);
      const docs: FileDoc[] = [];
      const failed: string[] = [];
      let firstError: Error | undefined;
      let done = 0;

      const queue = [...run.selection];
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          for (let path = queue.shift(); path; path = queue.shift()) {
            try {
              docs.push(
                await this.document(run, path, saved.get(path), context),
              );
            } catch (err) {
              if (err instanceof DocsSupersededError) throw err;
              this.logger.warn(
                `Doc for ${path} failed: ${(err as Error).stack ?? String(err)}`,
              );
              failed.push(path);
              firstError ??= err as Error;
            }
            await this.update(run, { done: ++done });
          }
        }),
      );

      if (run.selection.length && !docs.length) {
        throw firstError instanceof AnalysisError
          ? firstError
          : new AnalysisError(
              "Couldn't write docs for any of the selected files.",
            );
      }
      await this.finish(run, docs, saved, failed);
      this.logger.log(
        `Docs run ${run.runId}: ${docs.length} documented, ${failed.length} failed`,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  // Marks the run failed, unless a newer one has replaced it.
  async fail(
    run: Pick<DocsRun, 'userId' | 'projectId' | 'runId'>,
    err: unknown,
  ) {
    await this.update(run, {
      status: 'FAILED',
      finishedAt: new Date().toISOString(),
      error:
        err instanceof AnalysisError
          ? err.message
          : "The docs couldn't be written. Try again.",
    }).catch(() => undefined);
  }

  private context(run: DocsRun) {
    const locate = componentLocator(run.components);
    const byId = new Map(run.components.map((c) => [c.id, c]));
    const endpoints = endpointsByFile(run.api);
    const list = (set: Set<string> | undefined) =>
      [...(set ?? [])].sort().slice(0, MAX_LISTED_RELATIONS);
    return (path: string) => {
      const componentId = locate(path);
      return {
        componentId,
        component: componentId ? byId.get(componentId) : undefined,
        usedBy: list(run.imports.importers.get(path)),
        dependsOn: list(run.imports.imports.get(path)),
        endpoints: endpoints.get(path)?.routes ?? [],
      };
    };
  }

  private async document(
    run: DocsRun,
    path: string,
    saved: FileDoc | undefined,
    context: ReturnType<DocsWriter['context']>,
  ): Promise<FileDoc> {
    const text = await readText(run.repoDir, path, MAX_FILE_BYTES + 1);
    if (text === undefined) {
      throw new AnalysisError(`${path} isn't a text file.`);
    }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      throw new AnalysisError(`${path} is too large to document.`);
    }
    const hash = createHash('sha256').update(text).digest('hex');
    const { component, ...relations } = context(path);
    const base = {
      path,
      commit: run.commit,
      hash,
      ...relations,
      generatedAt: new Date().toISOString(),
    };
    // Same contents: keep the written doc, refreshed with this commit and its relations.
    if (saved?.hash === hash) {
      return { ...saved, ...base, generatedAt: saved.generatedAt };
    }

    const truncated = text.length > MAX_DOC_CHARS;
    const lines = text.slice(0, MAX_DOC_CHARS).split('\n');
    const facts = [
      `File: ${path}`,
      component
        ? `Component: ${component.name} (${component.tech}). ${component.description}`
        : 'Component: none of the mapped components',
      `Imported by: ${relations.usedBy.join(', ') || 'no files found'}`,
      `Imports: ${relations.dependsOn.join(', ') || 'no repository files'}`,
      relations.endpoints.length &&
        `Serves endpoints: ${relations.endpoints.join(', ')}`,
      truncated &&
        `Only the first ${lines.length} lines are shown; the file is longer.`,
    ].filter(Boolean);
    const result = await this.llm.callTool({
      system: DOC_SYSTEM,
      prompt: `${facts.join('\n')}\n\n${lines.map((l, i) => `${i + 1}| ${l}`).join('\n')}`,
      tool: {
        name: 'record_doc',
        description: 'Record the documentation for this file.',
        schema: DocResult,
      },
      effort: 'medium',
    });
    return {
      ...base,
      ...(relations.componentId && { componentId: relations.componentId }),
      summary: result.summary.trim(),
      purpose: result.purpose.trim(),
      keyParts: result.keyParts.slice(0, 12).map(({ line, ...part }) => ({
        ...part,
        // Only lines that exist, so every source link lands on something.
        ...(line >= 1 && line <= lines.length && { line }),
      })),
      notes: result.notes
        .map((n) => n.trim())
        .filter(Boolean)
        .slice(0, 5),
      truncated,
    };
  }

  private async savedDocs(run: DocsRun) {
    const docs = new Map<string, FileDoc>();
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {
            ':pk': userKey(run.userId),
            ':prefix': docPrefix(run.projectId),
          },
          ExclusiveStartKey,
        }),
      );
      for (const item of (page.Items ?? []) as DocItem[]) {
        docs.set(item.doc.path, item.doc);
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return docs;
  }

  // Saves the new docs, drops docs for files no longer selected, and completes the run, in
  // one transaction conditioned on this still being the current run. A file that failed
  // keeps its previous doc, if it had one.
  private async finish(
    run: DocsRun,
    docs: FileDoc[],
    saved: Map<string, FileDoc>,
    failed: string[],
  ) {
    const pk = userKey(run.userId);
    const keep = new Set(run.selection);
    const now = new Date().toISOString();
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...docs.map((doc) => {
              const item: DocItem = {
                PK: pk,
                SK: docKey(run.projectId, doc.path),
                runId: run.runId,
                doc,
              };
              return { Put: { TableName: this.tableName, Item: item } };
            }),
            ...[...saved.keys()]
              .filter((path) => !keep.has(path))
              .map((path) => ({
                Delete: {
                  TableName: this.tableName,
                  Key: { PK: pk, SK: docKey(run.projectId, path) },
                },
              })),
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: pk, SK: projectKey(run.projectId) },
                UpdateExpression:
                  'SET #docs.#status = :complete, #docs.finishedAt = :now, #docs.heartbeatAt = :now, #docs.failed = :failed REMOVE #docs.#error',
                ConditionExpression: '#docs.runId = :runId',
                ExpressionAttributeNames: {
                  '#docs': 'docs',
                  '#status': 'status',
                  '#error': 'error',
                },
                ExpressionAttributeValues: {
                  ':complete': 'COMPLETE',
                  ':now': now,
                  ':failed': failed,
                  ':runId': run.runId,
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
        throw new DocsSupersededError();
      }
      throw err;
    }
  }

  // Sets fields of the project's `docs` attribute and bumps its heartbeat, as long as this
  // is still the current docs run.
  private async update(
    run: Pick<DocsRun, 'userId' | 'projectId' | 'runId'>,
    fields: Record<string, unknown>,
  ) {
    const values: Record<string, unknown> = {
      ...fields,
      heartbeatAt: new Date().toISOString(),
    };
    const keys = Object.keys(values);
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userKey(run.userId), SK: projectKey(run.projectId) },
          UpdateExpression: `SET ${keys.map((k) => `#docs.#${k} = :${k}`).join(', ')}`,
          ConditionExpression: '#docs.#runId = :runId',
          ExpressionAttributeNames: Object.fromEntries(
            ['docs', ...keys, 'runId'].map((k) => [`#${k}`, k]),
          ),
          ExpressionAttributeValues: {
            ...Object.fromEntries(keys.map((k) => [`:${k}`, values[k]])),
            ':runId': run.runId,
          },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new DocsSupersededError();
      }
      throw err;
    }
  }
}
