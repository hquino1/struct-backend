import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CognitoAuthGuard, type AuthUser } from '../auth/cognito-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { isViewId } from '../analyzer/views/view-graph.js';
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

  // One explore view (e.g. `ci-cd`) from the latest completed analysis; the analysis's
  // `views` says which ones exist.
  @Get('views/:view')
  findView(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('view') view: string,
  ) {
    if (!isViewId(view)) throw new NotFoundException('Unknown view');
    return this.analysesService.findView(user.sub, projectId, view);
  }
}
