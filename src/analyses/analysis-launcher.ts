import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface AnalysisJob {
  userId: string;
  projectId: string;
  analysisId: string;
  repoUrl: string;
  branch: string;
}

// The worker reads its job from these variables (see worker.ts).
export const jobEnvironment = (job: AnalysisJob) => ({
  USER_ID: job.userId,
  PROJECT_ID: job.projectId,
  ANALYSIS_ID: job.analysisId,
  REPO_URL: job.repoUrl,
  BRANCH: job.branch,
});

// Starts the worker outside the API process: as a Fargate task in AWS, or as a child
// process during development (ANALYSIS_RUNNER=local, the default).
@Injectable()
export class AnalysisLauncher {
  private readonly logger = new Logger(AnalysisLauncher.name);
  private readonly runner: 'ecs' | 'local';
  private readonly ecs?: ECSClient;

  constructor(private readonly config: ConfigService) {
    this.runner = config.get('ANALYSIS_RUNNER') === 'ecs' ? 'ecs' : 'local';
    if (this.runner === 'ecs') {
      this.ecs = new ECSClient({
        region: config.getOrThrow<string>('AWS_REGION'),
      });
    }
  }

  async launch(job: AnalysisJob): Promise<void> {
    if (this.runner === 'ecs') return this.runTask(job);
    this.spawnLocal(job);
  }

  private async runTask(job: AnalysisJob) {
    const list = (key: string) =>
      this.config
        .getOrThrow<string>(key)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const result = await this.ecs!.send(
      new RunTaskCommand({
        cluster: this.config.getOrThrow<string>('ANALYZER_CLUSTER'),
        taskDefinition: this.config.getOrThrow<string>(
          'ANALYZER_TASK_DEFINITION',
        ),
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: list('ANALYZER_SUBNETS'),
            securityGroups: list('ANALYZER_SECURITY_GROUPS'),
            // Outbound access to GitHub and Bedrock without a NAT gateway.
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.config.get<string>(
                'ANALYZER_CONTAINER_NAME',
                'analyzer',
              ),
              environment: Object.entries(jobEnvironment(job)).map(
                ([name, value]) => ({ name, value }),
              ),
            },
          ],
        },
        // Lets a task be traced back to its analysis in the ECS console.
        startedBy: job.analysisId.slice(0, 36),
      }),
    );

    // RunTask reports capacity and configuration problems here instead of throwing.
    const failure = result.failures?.[0];
    if (failure || !result.tasks?.length) {
      throw new Error(
        `ECS could not start the analyzer: ${failure?.reason ?? 'no task started'}`,
      );
    }
  }

  private spawnLocal(job: AnalysisJob) {
    const worker = fileURLToPath(new URL('../worker.js', import.meta.url));
    const child = spawn(process.execPath, [worker], {
      env: { ...process.env, ...jobEnvironment(job) },
      stdio: 'inherit',
    });
    child.on('error', (err) =>
      this.logger.error(`Local analyzer failed to start: ${err.message}`),
    );
  }
}
