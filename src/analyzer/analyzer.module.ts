import { Module } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service.js';
import { LlmService } from './llm.service.js';

// Worker side: the analysis pipeline. Loaded only by worker.ts, never by the API.
@Module({
  providers: [AnalyzerService, LlmService],
  exports: [AnalyzerService],
})
export class AnalyzerModule {}
