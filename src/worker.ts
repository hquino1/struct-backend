import { NestFactory } from '@nestjs/core';
import type { AnalysisJob } from './analyses/analysis-launcher.js';
import { AnalyzerService } from './analyzer/analyzer.service.js';
import { WorkerModule } from './worker.module.js';

// Entry point for one analysis or docs run: a Fargate task (command `node dist/worker.js`) or a
// child process of the API in development. No HTTP server; it runs the job and exits.
function readJob(): AnalysisJob {
  const get = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  return {
    userId: get('USER_ID'),
    projectId: get('PROJECT_ID'),
    analysisId: get('ANALYSIS_ID'),
    repoUrl: get('REPO_URL'),
    branch: get('BRANCH'),
    ...(process.env.INSTALLATION_ID && {
      installationId: Number(process.env.INSTALLATION_ID),
    }),
    ...(process.env.JOB_KIND === 'docs' && {
      kind: 'docs' as const,
      docsRunId: get('DOCS_RUN_ID'),
      commit: get('COMMIT'),
    }),
  };
}

async function main() {
  const job = readJob();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  try {
    const analyzer = app.get(AnalyzerService);
    const ok = await (job.kind === 'docs'
      ? analyzer.runDocs(job)
      : analyzer.run(job));
    process.exitCode = ok ? 0 : 1;
  } finally {
    await app.close();
  }
}
await main();
