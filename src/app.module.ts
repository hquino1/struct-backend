import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AnalysesModule } from './analyses/analyses.module.js';
import { DynamoDBModule } from './dynamodb/dynamodb.module.js';
import { ProjectsModule } from './projects/projects.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DynamoDBModule,
    ProjectsModule,
    AnalysesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
