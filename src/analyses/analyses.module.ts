import { Module } from '@nestjs/common';
import { CognitoAuthGuard } from '../auth/cognito-auth.guard.js';
import { AnalysesController } from './analyses.controller.js';
import { AnalysesService } from './analyses.service.js';
import { AnalysisLauncher } from './analysis-launcher.js';

// API side only: starts the worker and reads its progress. The pipeline lives in
// AnalyzerModule, which the API never loads.
@Module({
  controllers: [AnalysesController],
  providers: [AnalysesService, AnalysisLauncher, CognitoAuthGuard],
})
export class AnalysesModule {}
