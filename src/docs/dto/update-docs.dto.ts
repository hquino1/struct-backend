import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { MAX_DOC_FILES, type DocsMode } from '../docs.entity.js';

// "auto" documents the suggested files on every analysis; "manual" documents `paths`.
export class UpdateDocsDto {
  @IsIn(['auto', 'manual'])
  mode!: DocsMode;

  @ValidateIf((dto: UpdateDocsDto) => dto.mode === 'manual')
  @IsArray()
  @ArrayMinSize(1, { message: 'Pick at least one file to document' })
  @ArrayMaxSize(MAX_DOC_FILES, {
    message: `Pick at most ${MAX_DOC_FILES} files to document`,
  })
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  paths?: string[];
}
