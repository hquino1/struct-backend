import { Module } from '@nestjs/common';
import { GitHubAppService } from '../github/github-app.service.js';
import { AnalyzerService } from './analyzer.service.js';
import { DocsWriter } from './docs/docs-writer.service.js';
import { LlmService } from './llm.service.js';

// Worker side: the analysis pipeline. Loaded only by worker.ts, never by the API.
@Module({
  providers: [AnalyzerService, DocsWriter, LlmService, GitHubAppService],
  exports: [AnalyzerService],
})
export class AnalyzerModule {}
