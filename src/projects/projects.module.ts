import { Module } from '@nestjs/common';
import { CognitoAuthGuard } from '../auth/cognito-auth.guard.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, CognitoAuthGuard],
})
export class ProjectsModule {}
