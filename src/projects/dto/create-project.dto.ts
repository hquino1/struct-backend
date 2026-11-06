import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const GITHUB_REPO_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export class CreateProjectDto {
  @IsString()
  @Matches(GITHUB_REPO_URL, {
    message:
      'repoUrl must be a GitHub repository URL like https://github.com/owner/repo',
  })
  repoUrl: string;

  // Defaults to the repository name when omitted.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  // Defaults to the repository's default branch when omitted; must exist on GitHub.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  branch?: string;
}
