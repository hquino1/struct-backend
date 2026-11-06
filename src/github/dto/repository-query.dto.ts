import { IsString, Matches } from 'class-validator';
import { GITHUB_REPO_URL } from '../../projects/dto/create-project.dto.js';

// A repository that isn't a project yet, as the import form names it.
export class RepositoryQueryDto {
  @IsString()
  @Matches(GITHUB_REPO_URL, {
    message:
      'repoUrl must be a GitHub repository URL like https://github.com/owner/repo',
  })
  repoUrl: string;
}
