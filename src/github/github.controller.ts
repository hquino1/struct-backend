import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CognitoAuthGuard, type AuthUser } from '../auth/cognito-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ConnectGitHubDto } from './dto/connect-github.dto.js';
import { RepositoryQueryDto } from './dto/repository-query.dto.js';
import { GitHubService } from './github.service.js';

@Controller('github')
@UseGuards(CognitoAuthGuard)
export class GitHubController {
  constructor(private readonly githubService: GitHubService) {}

  // The linked account, plus the links that start GitHub's install and sign-in pages.
  @Get('connection')
  getConnection(@CurrentUser() user: AuthUser) {
    return this.githubService.getConnection(user.sub);
  }

  @Post('connection')
  connect(@CurrentUser() user: AuthUser, @Body() dto: ConnectGitHubDto) {
    return this.githubService.connect(user.sub, dto.code, dto.state);
  }

  // A repository's branches before it's imported, for the import form's branch picker.
  @Get('branches')
  listBranches(
    @CurrentUser() user: AuthUser,
    @Query() query: RepositoryQueryDto,
  ) {
    return this.githubService.listRepositoryBranches(user.sub, query.repoUrl);
  }

  // Existing private projects stop being analyzable until the user connects again.
  @Delete('connection')
  @HttpCode(204)
  disconnect(@CurrentUser() user: AuthUser) {
    return this.githubService.disconnect(user.sub);
  }
}
