import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// The repository is fixed once a project exists; import it again to track a different one.
export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/\S/, { message: 'name must not be empty' })
  name?: string;

  // Takes effect on the next analysis; the saved graph stays until then.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/\S/, { message: 'branch must not be empty' })
  branch?: string;
}
