import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisJob } from '../analyses/analysis-launcher.js';
import {
  graphKey,
  viewKey,
  type AnalysisStep,
  type AnalysisViews,
  type GraphItem,
  type ProjectAnalysis,
  type ViewItem,
} from '../analyses/analysis.entity.js';
import {
  DEFAULT_DOCS,
  filesKey,
  isDocumentable,
  packPaths,
  unpackPaths,
  type DocSuggestion,
  type FilesItem,
  type ProjectDocs,
} from '../docs/docs.entity.js';
import { DYNAMODB_CLIENT } from '../dynamodb/dynamodb.constants.js';
import { GitHubAppService } from '../github/github-app.service.js';
import { GITHUB_REPO_URL } from '../projects/dto/create-project.dto.js';
import {
  projectKey,
  userKey,
  type ProjectItem,
} from '../projects/project.entity.js';
import { DocsSupersededError, DocsWriter } from './docs/docs-writer.service.js';
import { ImportGraph, suggestFiles } from './docs/suggest.js';
import {
  ComponentsResult,
  ConnectionsResult,
  FaqResult,
  type ArchitectureGraph,
  type Component,
  type Connection,
  type FaqEntry,
} from './architecture.js';
import { LlmService } from './llm.service.js';
import { FAQ_SYSTEM, MAP_SYSTEM, TRACE_SYSTEM } from './prompts.js';
import { buildMapDigest, buildTraceDigest, scanCode } from './repo-digest.js';
import {
  AnalysisError,
  cloneCommit,
  cloneRepository,
  listRepositoryFiles,
  scanRepository,
} from './repository.js';
import { VIEW_EXTRACTORS } from './views/extractors.js';
import type { ViewContext, ViewGraph, ViewId } from './views/view-graph.js';

// Well inside HEARTBEAT_TIMEOUT_MS, so a slow step never looks like a dead task.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Keeps the graph comfortably under DynamoDB's 400 KB item limit.
const MAX_GRAPH_BYTES = 350_000;

// How much of each explore view the FAQ step sees, to bound its prompt on large repos.
const MAX_FAQ_NODES = 60;
const MAX_FAQ_FIELDS = 12;
const MAX_FAQ_PATHS = 4;

interface BuiltViews {
  status: AnalysisViews;
  graphs: Partial<Record<ViewId, ViewGraph>>;
}

// What a finished analysis hands to the docs run that follows it.
interface Analyzed {
  repoDir: string;
  commit: string;
  components: Component[];
  api?: ViewGraph;
  imports: ImportGraph;
  documentable: string[];
  suggestions: DocSuggestion[];
}

// Thrown when a newer run has replaced this one; the old worker just stops.
class SupersededError extends Error {}

@Injectable()
export class AnalyzerService {
  private readonly logger = new Logger(AnalyzerService.name);
  private readonly tableName: string;

  constructor(
    @Inject(DYNAMODB_CLIENT) private readonly db: DynamoDBDocumentClient,
    private readonly llm: LlmService,
    private readonly github: GitHubAppService,
    private readonly docsWriter: DocsWriter,
    config: ConfigService,
  ) {
    this.tableName = config.getOrThrow<string>('DYNAMODB_PROJECTS_TABLE');
  }

  // Runs the whole pipeline, recording progress on the analysis item as it goes, then
  // writes the docs for the project's selected files. Resolves false if the analysis failed;
  // a docs failure is reported on the project's docs instead.
  async run(job: AnalysisJob): Promise<boolean> {
    const workDir = await mkdtemp(join(tmpdir(), 'struct-analysis-'));
    const heartbeat = setInterval(() => {
      this.update(job, {}).catch((err: Error) =>
        this.logger.warn(`Heartbeat failed: ${err.message}`),
      );
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const analyzed = await this.analyze(job, workDir).finally(() =>
        clearInterval(heartbeat),
      );
      if (!analyzed) return false;
      if (analyzed !== 'superseded') {
        await this.documentAfterAnalysis(job, analyzed);
      }
      return true;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // Writes the docs again after the user changed which files to document. The analysis it
  // documents is already saved; this reads its commit, graph, and file list.
  async runDocs(job: AnalysisJob): Promise<boolean> {
    const run = {
      userId: job.userId,
      projectId: job.projectId,
      runId: job.docsRunId!,
    };
    const workDir = await mkdtemp(join(tmpdir(), 'struct-docs-'));
    try {
      const pk = userKey(job.userId);
      const get = async <T>(SK: string) =>
        (
          await this.db.send(
            new GetCommand({ TableName: this.tableName, Key: { PK: pk, SK } }),
          )
        ).Item as T | undefined;
      const [project, graphItem, filesItem, apiItem] = await Promise.all([
        get<ProjectItem>(projectKey(job.projectId)),
        get<GraphItem>(graphKey(job.projectId)),
        get<FilesItem>(filesKey(job.projectId)),
        get<ViewItem>(viewKey(job.projectId, 'api')),
      ]);
      const docs = project?.docs;
      if (docs?.runId !== run.runId) throw new DocsSupersededError();
      if (!graphItem || !filesItem) {
        throw new AnalysisError(
          'This project has no completed analysis to document. Re-analyze it first.',
        );
      }
      const paths = unpackPaths(filesItem.paths);
      const repoDir = join(workDir, 'repo');
      await cloneCommit(
        job.repoUrl,
        job.commit!,
        repoDir,
        await this.cloneToken(job),
      );
      const components = graphItem.graph.components;
      const imports = new ImportGraph();
      await scanCode(repoDir, paths, components, (from, to) =>
        imports.add(from, to),
      );
      await this.docsWriter.write({
        ...run,
        commit: job.commit!,
        repoDir,
        selection: this.docsSelection(docs, paths, filesItem.suggestions),
        components,
        api: apiItem?.graph,
        imports,
      });
      return true;
    } catch (err) {
      if (err instanceof DocsSupersededError) {
        this.logger.warn(`Docs run ${run.runId} was replaced by a newer run`);
        return true;
      }
      this.logger.error(
        `Docs run ${run.runId} failed: ${(err as Error).stack ?? String(err)}`,
      );
      await this.docsWriter.fail(run, err);
      return false;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // The files a docs run covers: the suggestions, or the user's pick minus files that no
  // longer exist.
  private docsSelection(
    docs: ProjectDocs,
    paths: string[],
    suggestions: DocSuggestion[],
  ) {
    if (docs.mode === 'auto') return suggestions.map((s) => s.path);
    const available = new Set(paths);
    return (docs.selection ?? []).filter((p) => available.has(p));
  }

  // Starts a docs run for the commit this analysis read, replacing any older docs run.
  private async documentAfterAnalysis(job: AnalysisJob, analyzed: Analyzed) {
    const pk = userKey(job.userId);
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: pk, SK: projectKey(job.projectId) },
        ProjectionExpression: '#docs',
        ExpressionAttributeNames: { '#docs': 'docs' },
      }),
    );
    const previous = (Item as ProjectItem | undefined)?.docs ?? DEFAULT_DOCS;
    const selection = this.docsSelection(
      previous,
      analyzed.documentable,
      analyzed.suggestions,
    );
    const runId = randomUUID();
    const now = new Date().toISOString();
    const docs: ProjectDocs = {
      mode: previous.mode,
      ...(previous.selection && { selection: previous.selection }),
      status: 'QUEUED',
      runId,
      startedAt: now,
      heartbeatAt: now,
      commit: analyzed.commit,
      total: selection.length,
      done: 0,
      failed: [],
    };
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: pk, SK: projectKey(job.projectId) },
          UpdateExpression: 'SET #docs = :docs',
          // Skipped when a newer analysis replaced this one, or when the user started a docs
          // run since the read above (that run already documents this commit).
          ConditionExpression: `#analysis.analysisId = :analysisId AND ${
            previous.runId
              ? '#docs.runId = :previousRunId'
              : 'attribute_not_exists(#docs.runId)'
          }`,
          ExpressionAttributeNames: {
            '#analysis': 'analysis',
            '#docs': 'docs',
          },
          ExpressionAttributeValues: {
            ':docs': docs,
            ':analysisId': job.analysisId,
            ...(previous.runId && { ':previousRunId': previous.runId }),
          },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        this.logger.warn(`Analysis ${job.analysisId}: docs run skipped`);
        return;
      }
      throw err;
    }

    const run = {
      userId: job.userId,
      projectId: job.projectId,
      runId,
      commit: analyzed.commit,
      repoDir: analyzed.repoDir,
      selection,
      components: analyzed.components,
      api: analyzed.api,
      imports: analyzed.imports,
    };
    try {
      await this.docsWriter.write(run);
    } catch (err) {
      if (err instanceof DocsSupersededError) {
        this.logger.warn(`Docs run ${runId} was replaced by a newer run`);
        return;
      }
      this.logger.error(
        `Docs run ${runId} failed: ${(err as Error).stack ?? String(err)}`,
      );
      await this.docsWriter.fail(run, err);
    }
  }

  // The analysis itself: everything up to the saved graph. Resolves what the docs run
  // needs, false if it failed, or 'superseded' if a newer run replaced it.
  private async analyze(
    job: AnalysisJob,
    workDir: string,
  ): Promise<Analyzed | false | 'superseded'> {
    try {
      const repoDir = join(workDir, 'repo');
      await this.setStep(job, 'clone');
      const commit = await cloneRepository(
        job.repoUrl,
        job.branch,
        repoDir,
        await this.cloneToken(job),
      );

      await this.setStep(job, 'detect', { commit });
      const paths = await listRepositoryFiles(repoDir);
      const stats = scanRepository(paths);

      await this.setStep(job, 'map', { stats });
      const components = await this.mapComponents(repoDir, paths);

      await this.setStep(job, 'trace');
      // One read of the code serves both the trace and the explore views. The views need no
      // model call, so they finish while the trace waits on the model.
      const imports = new ImportGraph();
      const facts = await scanCode(repoDir, paths, components, (from, to) =>
        imports.add(from, to),
      );
      const { digest, fileCounts } = buildTraceDigest(components, facts);
      const [connections, views] = await Promise.all([
        this.traceConnections(components, digest),
        this.buildViews({ repoDir, paths, components, facts, llm: this.llm }),
      ]);

      // The step keeps its old id so runs in progress during a deploy still report it.
      await this.setStep(job, 'insights');
      const faq = await this.answerFaq(components, connections, views, paths);
      const documentable = paths.filter(isDocumentable);
      const suggestions = suggestFiles({
        paths: documentable,
        components,
        views: views.graphs,
        imports,
      });

      await this.complete(
        job,
        {
          components: components.map((c) => ({
            ...c,
            files: fileCounts[c.id] ?? 0,
          })),
          connections,
          faq,
        },
        views,
        this.filesItem(job, commit, documentable, suggestions),
      );
      this.logger.log(`Analysis ${job.analysisId} complete`);
      return {
        repoDir,
        commit,
        components,
        api: views.graphs.api,
        imports,
        documentable,
        suggestions,
      };
    } catch (err) {
      if (err instanceof SupersededError) {
        this.logger.warn(
          `Analysis ${job.analysisId} was replaced by a newer run`,
        );
        return 'superseded';
      }
      const cause = (err as Error).cause;
      this.logger.error(
        `Analysis ${job.analysisId} failed: ${(err as Error).stack ?? String(err)}` +
          (cause === undefined
            ? ''
            : `\nCaused by: ${(cause as Error).stack ?? String(cause)}`),
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
    }
  }

  // The documentable file list and the suggestions for the file picker, saved with the
  // graph by `complete`.
  private filesItem(
    job: AnalysisJob,
    commit: string,
    documentable: string[],
    suggestions: DocSuggestion[],
  ): FilesItem {
    let paths = documentable;
    let packed = packPaths(paths);
    // Only a repository of very long paths gets near the item limit; keep what fits.
    while (packed.byteLength > MAX_GRAPH_BYTES) {
      paths = paths.slice(0, Math.floor(paths.length * 0.8));
      packed = packPaths(paths);
    }
    return {
      PK: userKey(job.userId),
      SK: filesKey(job.projectId),
      analysisId: job.analysisId,
      commit,
      paths: packed,
      suggestions,
    };
  }

  // A read-only token for this one repository when it's private; none for public ones.
  private async cloneToken(job: AnalysisJob): Promise<string | undefined> {
    if (job.installationId === undefined) return undefined;
    const [, , repo] = GITHUB_REPO_URL.exec(job.repoUrl)!;
    try {
      return await this.github.repositoryToken(job.installationId, repo, {
        contents: 'read',
      });
    } catch (err) {
      this.logger.error(`Repository token failed: ${(err as Error).message}`);
      throw new AnalysisError(
        'Struct no longer has access to this repository. Install the Struct GitHub App on it again.',
      );
    }
  }

  // Builds every view that applies. A view that fails is reported as FAILED rather than
  // failing the analysis: the architecture map is still worth saving.
  private async buildViews(context: ViewContext): Promise<BuiltViews> {
    const built: BuiltViews = { status: {}, graphs: {} };
    await Promise.all(
      VIEW_EXTRACTORS.map(async (extractor) => {
        const { view } = extractor;
        if (!extractor.applies(context.paths)) {
          built.status[view] = 'NOT_APPLICABLE';
          return;
        }
        try {
          const graph = await extractor.extract(context);
          if (!graph.nodes.length) {
            built.status[view] = 'NOT_APPLICABLE';
          } else if (
            Buffer.byteLength(JSON.stringify(graph)) > MAX_GRAPH_BYTES
          ) {
            this.logger.warn(`View ${view} is too large to save`);
            built.status[view] = 'FAILED';
          } else {
            built.status[view] = 'COMPLETE';
            built.graphs[view] = graph;
          }
        } catch (err) {
          this.logger.warn(
            `View ${view} failed: ${(err as Error).stack ?? String(err)}`,
          );
          built.status[view] = 'FAILED';
        }
      }),
    );
    return built;
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

  // Answers the questions a newcomer asks first, from the map and the explore views.
  private async answerFaq(
    components: Component[],
    connections: Connection[],
    views: BuiltViews,
    paths: string[],
  ): Promise<FaqEntry[]> {
    const summarize = (view: ViewId) =>
      views.graphs[view]?.nodes.slice(0, MAX_FAQ_NODES).map((n) => ({
        name: n.name,
        kind: n.kind,
        group: n.group,
        ...(n.detail && { detail: n.detail }),
        ...(n.path && { path: n.path }),
        ...(n.componentId && { componentId: n.componentId }),
        ...(n.fields && {
          fields: n.fields.slice(0, MAX_FAQ_FIELDS).map((f) => f.name),
        }),
      }));
    const input = {
      components: components.map(
        ({ id, name, type, tech, description, paths, entryPoint }) => ({
          id,
          name,
          type,
          tech,
          description,
          paths,
          entryPoint,
        }),
      ),
      connections,
      endpoints: summarize('api'),
      dataModel: summarize('schema'),
      infrastructure: summarize('infrastructure'),
      ciCd: summarize('ci-cd'),
      screens: summarize('screens'),
    };
    const { faq } = await this.llm.callTool({
      system: FAQ_SYSTEM,
      prompt: JSON.stringify(input, null, 2),
      tool: {
        name: 'record_faq',
        description: 'Record the answers to the FAQ about this repository.',
        schema: FaqResult,
      },
      effort: 'medium',
    });

    // Keep only references that exist, so every link on the page opens something.
    const ids = new Set(components.map((c) => c.id));
    const files = new Set(paths);
    const dirs = new Set(
      paths.flatMap((p) => {
        const parts = p.split('/');
        return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
      }),
    );
    const reference = (raw: string) => {
      const path = raw
        .trim()
        .replace(/^\.?\//, '')
        .replace(/\/+$/, '');
      return files.has(path) ? [path] : dirs.has(path) ? [`${path}/`] : [];
    };
    return faq
      .filter((e) => e.question.trim() && e.answer.trim())
      .map((e) => ({
        ...e,
        componentIds: [...new Set(e.componentIds)].filter((id) => ids.has(id)),
        paths: [...new Set(e.paths.flatMap(reference))].slice(0, MAX_FAQ_PATHS),
      }));
  }

  // Saves the graph, views, and file list and marks the run complete in one transaction, so
  // a run that a newer one has replaced can't overwrite the newer results. The update's own
  // condition guards every write, so no separate ConditionCheck (and IAM action) is needed.
  private async complete(
    job: AnalysisJob,
    graph: ArchitectureGraph,
    views: BuiltViews,
    files: FilesItem,
  ) {
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
    // Each view is replaced, or deleted when this run didn't build it, so a view never
    // outlives the run it came from.
    const viewWrites = VIEW_EXTRACTORS.map(({ view }) => {
      const key = { PK: userKey(job.userId), SK: viewKey(job.projectId, view) };
      const viewGraph = views.graphs[view];
      if (!viewGraph) {
        return { Delete: { TableName: this.tableName, Key: key } };
      }
      const viewItem: ViewItem = {
        ...key,
        analysisId: job.analysisId,
        view,
        graph: viewGraph,
      };
      return { Put: { TableName: this.tableName, Item: viewItem } };
    });
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: item } },
            { Put: { TableName: this.tableName, Item: files } },
            ...viewWrites,
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  PK: userKey(job.userId),
                  SK: projectKey(job.projectId),
                },
                UpdateExpression:
                  'SET #analysis.#status = :complete, #analysis.finishedAt = :now, #analysis.heartbeatAt = :now, #analysis.#views = :views',
                ConditionExpression: '#analysis.analysisId = :analysisId',
                ExpressionAttributeNames: {
                  '#analysis': 'analysis',
                  '#status': 'status',
                  '#views': 'views',
                },
                ExpressionAttributeValues: {
                  ':complete': 'COMPLETE',
                  ':now': now,
                  ':views': views.status,
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
