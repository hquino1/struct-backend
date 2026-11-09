import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CognitoAuthGuard, type AuthUser } from '../auth/cognito-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { DocsService } from './docs.service.js';
import { UpdateDocsDto } from './dto/update-docs.dto.js';

@Controller('projects/:projectId')
@UseGuards(CognitoAuthGuard)
export class DocsController {
  constructor(private readonly docsService: DocsService) {}

  // The project's file docs and the latest docs run; poll while it is QUEUED or RUNNING.
  @Get('docs')
  findDocs(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.docsService.findDocs(user.sub, projectId);
  }

  // Changes which files are documented and starts writing their docs.
  @Put('docs')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateDocsDto,
  ) {
    return this.docsService.update(user.sub, projectId, dto);
  }

  // Every documentable file of the latest analysis, with the suggested ones and why.
  @Get('files')
  findFiles(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.docsService.findFiles(user.sub, projectId);
  }
}
