import { Module } from '@nestjs/common';
import { AnalysisLauncher } from '../analyses/analysis-launcher.js';
import { CognitoAuthGuard } from '../auth/cognito-auth.guard.js';
import { GitHubModule } from '../github/github.module.js';
import { DocsController } from './docs.controller.js';
import { DocsService } from './docs.service.js';

// API side only: reads docs and starts docs runs on the analyzer worker. The worker's
// writer lives in AnalyzerModule.
@Module({
  imports: [GitHubModule],
  controllers: [DocsController],
  providers: [DocsService, AnalysisLauncher, CognitoAuthGuard],
})
export class DocsModule {}
