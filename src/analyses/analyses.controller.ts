import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CognitoAuthGuard, type AuthUser } from '../auth/cognito-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AnalysesService } from './analyses.service.js';

@Controller('projects/:projectId')
@UseGuards(CognitoAuthGuard)
export class AnalysesController {
  constructor(private readonly analysesService: AnalysesService) {}

  // Returns as soon as the worker is launched; poll GET for progress.
  @Post('analysis')
  @HttpCode(202)
  start(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.analysesService.start(user.sub, projectId);
  }

  // The latest analysis, or `{ analysis: null }` when the project was never analyzed.
  @Get('analysis')
  async findLatest(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return {
      analysis: await this.analysesService.findLatest(user.sub, projectId),
    };
  }

  // The architecture graph from the latest completed analysis; 404 until one completes.
  @Get('graph')
  findGraph(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.analysesService.findGraph(user.sub, projectId);
  }
}
