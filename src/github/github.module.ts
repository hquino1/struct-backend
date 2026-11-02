import { Module } from '@nestjs/common';
import { CognitoAuthGuard } from '../auth/cognito-auth.guard.js';
import { GitHubAppService } from './github-app.service.js';
import { GitHubController } from './github.controller.js';
import { GitHubService } from './github.service.js';

// API side: connecting GitHub accounts and checking private-repository access. The worker
// uses GitHubAppService on its own (see AnalyzerModule).
@Module({
  controllers: [GitHubController],
  providers: [GitHubService, GitHubAppService, CognitoAuthGuard],
  exports: [GitHubService],
})
export class GitHubModule {}
