import { Module } from '@nestjs/common';
import { CognitoAuthGuard } from '../auth/cognito-auth.guard.js';
import { GitHubModule } from '../github/github.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  imports: [GitHubModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, CognitoAuthGuard],
})
export class ProjectsModule {}
