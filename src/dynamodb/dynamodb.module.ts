import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DYNAMODB_CLIENT } from './dynamodb.constants.js';

// Credentials come from the default AWS provider chain (env vars, ~/.aws, or an IAM role).
@Global()
@Module({
  providers: [
    {
      provide: DYNAMODB_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const client = new DynamoDBClient({
          region: config.getOrThrow<string>('AWS_REGION'),
          // Set DYNAMODB_ENDPOINT to point at DynamoDB Local during development.
          endpoint: config.get<string>('DYNAMODB_ENDPOINT') || undefined,
        });
        return DynamoDBDocumentClient.from(client, {
          marshallOptions: { removeUndefinedValues: true },
        });
      },
    },
  ],
  exports: [DYNAMODB_CLIENT],
})
export class DynamoDBModule {}
