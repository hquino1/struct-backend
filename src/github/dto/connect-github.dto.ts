import { IsString, MaxLength } from 'class-validator';

// What GitHub's redirect to the frontend's /github/callback page carries.
export class ConnectGitHubDto {
  @IsString()
  @MaxLength(100)
  code: string;

  @IsString()
  @MaxLength(500)
  state: string;
}
