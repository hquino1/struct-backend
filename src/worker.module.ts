import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyzerModule } from './analyzer/analyzer.module.js';
import { DynamoDBModule } from './dynamodb/dynamodb.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DynamoDBModule,
    AnalyzerModule,
  ],
})
export class WorkerModule {}
