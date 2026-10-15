import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AnthropicBedrock,
  AnthropicBedrockMantle,
} from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessageParam,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  BedrockRuntimeClient,
  BedrockRuntimeServiceException,
  ConverseCommand,
  type Message,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { AnalysisError } from './repository.js';

export interface ToolRequest<T extends z.ZodType> {
  // Stable instructions, sent as the system prompt.
  system: string;
  // The per-repository input.
  prompt: string;
  tool: { name: string; description: string; schema: T };
  // Thinking depth; applies to Claude models only.
  effort: 'low' | 'medium' | 'high';
}

// The model is asked to answer through a tool, and re-asked this many times when it doesn't.
const MAX_ATTEMPTS = 3;
// Output cap for non-Claude models; the tool inputs here are a few thousand tokens.
const CONVERSE_MAX_TOKENS = 16_000;

// A failure of one model on this request (unavailable, refused, unusable output). The
// fallback model, if any, gets a try before the analysis fails with this message.
class ModelError extends AnalysisError {}

interface Turn {
  stop:
    'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'too_long' | 'other';
  call?: { id: string; input: unknown };
}

// One back-and-forth with a model, in that provider's message format.
interface Conversation {
  send(): Promise<Turn>;
  // Adds a user message, e.g. asking again for the tool call.
  nudge(text: string): void;
  // Answers a tool call with an error, so the model can correct its input.
  rejectToolCall(id: string, text: string): void;
}

// Claude model IDs go through the Anthropic SDK, which exposes thinking and effort; any other
// Bedrock model (Amazon Nova, Qwen, Llama, gpt-oss, ...) goes through the Converse API.
const isClaude = (model: string) => /(^|\.)anthropic\./.test(model);
// Claude IDs with a cross-region prefix (`global.`, `us.`, ...) or a version suffix belong to
// Bedrock's InvokeModel API; bare `anthropic.claude-*` IDs to its Messages-API endpoint.
const isInvokeModelId = (model: string) =>
  /^(global|us|eu|apac|jp|au)\./.test(model) || model.includes(':');

const unavailable = (model: string) =>
  new ModelError(
    `The AI model ${model} isn't available to this AWS account. Check Bedrock model access and IAM permissions.`,
  );
const serviceDown = () =>
  new ModelError(
    'The AI service is unavailable right now. Try again in a few minutes.',
  );

// Calls a model on Amazon Bedrock and returns a tool call's validated input. A tool whose
// input_schema is the answer's shape stands in for structured outputs, which Bedrock
// doesn't offer across models.
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly models: string[];
  private readonly region: string;
  // Created on first use, so a Claude-only or Converse-only setup builds one client.
  private converse?: BedrockRuntimeClient;
  private readonly claudeClients = new Map<
    string,
    AnthropicBedrock | AnthropicBedrockMantle
  >();

  constructor(config: ConfigService) {
    this.region = config.getOrThrow<string>('AWS_REGION');
    this.models = [
      config.getOrThrow<string>('BEDROCK_MODEL'),
      config.get<string>('BEDROCK_FALLBACK_MODEL'),
    ].filter((m): m is string => !!m);
  }

  async callTool<T extends z.ZodType>(
    request: ToolRequest<T>,
  ): Promise<z.infer<T>> {
    let lastError: ModelError | undefined;
    for (const [i, model] of this.models.entries()) {
      try {
        return await this.callToolWith(model, request);
      } catch (err) {
        if (!(err instanceof ModelError)) throw err;
        lastError = err;
        const next = this.models[i + 1];
        if (next) {
          this.logger.warn(
            `${request.tool.name}: ${model} failed (${err.message}) — retrying on ${next}`,
          );
        }
      }
    }
    throw lastError!;
  }

  private async callToolWith<T extends z.ZodType>(
    model: string,
    request: ToolRequest<T>,
  ): Promise<z.infer<T>> {
    const { name, schema } = request.tool;
    const conversation = isClaude(model)
      ? this.claudeConversation(model, request)
      : this.converseConversation(model, request);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const turn = await conversation.send();
      if (turn.stop === 'refusal') {
        throw new ModelError(
          'The AI model declined to analyze this repository.',
        );
      }
      if (turn.stop === 'too_long') {
        throw new ModelError(
          'This repository is too large for the AI model to analyze.',
        );
      }
      if (!turn.call) {
        conversation.nudge(
          turn.stop === 'max_tokens'
            ? `Your answer was cut off. Call the ${name} tool again with a more concise answer.`
            : `Answer by calling the ${name} tool.`,
        );
        continue;
      }
      const parsed = schema.safeParse(turn.call.input);
      if (parsed.success) return parsed.data;
      conversation.rejectToolCall(
        turn.call.id,
        `The input didn't match the schema. Fix these problems and call ${name} again:\n${z.prettifyError(parsed.error)}`,
      );
    }
    throw new ModelError(
      "The AI model didn't return a usable result. Try running the analysis again.",
    );
  }

  private inputSchema(schema: z.ZodType) {
    const { $schema: _, ...json } = z.toJSONSchema(schema) as Record<
      string,
      unknown
    >;
    return json;
  }

  private claudeConversation(
    model: string,
    request: ToolRequest<z.ZodType>,
  ): Conversation {
    let client = this.claudeClients.get(model);
    if (!client) {
      // Credentials resolve through the AWS chain: AWS_* env vars locally, the task role
      // on Fargate. Rate limits (429) and 5xx errors are retried with backoff.
      const options = { awsRegion: this.region, maxRetries: 4 };
      client = isInvokeModelId(model)
        ? new AnthropicBedrock(options)
        : new AnthropicBedrockMantle(options);
      this.claudeClients.set(model, client);
    }
    const { name, description, schema } = request.tool;
    const tool: BetaTool = {
      name,
      description,
      input_schema: this.inputSchema(schema) as BetaTool['input_schema'],
    };
    const messages: BetaMessageParam[] = [
      { role: 'user', content: request.prompt },
    ];
    const claude = client;

    return {
      send: async () => {
        let response;
        try {
          // Streamed so long generations don't hit HTTP timeouts.
          response = await claude.beta.messages
            .stream({
              model,
              max_tokens: 64_000,
              thinking: { type: 'adaptive' },
              output_config: { effort: request.effort },
              system: [
                {
                  type: 'text',
                  text: request.system,
                  cache_control: { type: 'ephemeral' },
                },
              ],
              tools: [tool],
              // Newer Claude models reject forced tool choice; the prompt asks instead.
              tool_choice: { type: 'auto' },
              messages,
            })
            .finalMessage();
        } catch (err) {
          if (!(err instanceof Anthropic.APIError)) throw err;
          this.logger.error(
            `${model} request failed (${err.status ?? 'network'}): ${err.message}`,
          );
          // Bedrock answers 403/404 when the account can't use the model in this region.
          throw err.status === 403 || err.status === 404
            ? unavailable(model)
            : serviceDown();
        }
        const { usage } = response;
        this.logger.log(
          `${name} on ${model}: ${usage.input_tokens} input (${usage.cache_read_input_tokens ?? 0} cached), ${usage.output_tokens} output tokens, stop: ${response.stop_reason}`,
        );
        // Echoed back unchanged so thinking blocks stay valid on a retry.
        messages.push({ role: 'assistant', content: response.content });
        const call = response.content.find(
          (b) => b.type === 'tool_use' && b.name === name,
        );
        const stop = response.stop_reason;
        return {
          stop:
            stop === 'refusal'
              ? 'refusal'
              : stop === 'model_context_window_exceeded'
                ? 'too_long'
                : stop === 'tool_use' ||
                    stop === 'end_turn' ||
                    stop === 'max_tokens'
                  ? stop
                  : 'other',
          call:
            call?.type === 'tool_use'
              ? { id: call.id, input: call.input }
              : undefined,
        };
      },
      nudge: (text) => messages.push({ role: 'user', content: text }),
      rejectToolCall: (id, text) =>
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              is_error: true,
              content: text,
            },
          ],
        }),
    };
  }

  private converseConversation(
    model: string,
    request: ToolRequest<z.ZodType>,
  ): Conversation {
    // Throttling and transient 5xx errors are retried by the AWS SDK itself.
    this.converse ??= new BedrockRuntimeClient({
      region: this.region,
      maxAttempts: 5,
    });
    const client = this.converse;
    const { name, description, schema } = request.tool;
    const messages: Message[] = [
      { role: 'user', content: [{ text: request.prompt }] },
    ];

    return {
      send: async () => {
        let response;
        try {
          response = await client.send(
            new ConverseCommand({
              modelId: model,
              system: [{ text: request.system }],
              messages,
              toolConfig: {
                tools: [
                  {
                    toolSpec: {
                      name,
                      description,
                      inputSchema: {
                        json: this.inputSchema(schema),
                      } as ToolInputSchema,
                    },
                  },
                ],
              },
              inferenceConfig: { maxTokens: CONVERSE_MAX_TOKENS },
            }),
          );
        } catch (err) {
          if (!(err instanceof BedrockRuntimeServiceException)) throw err;
          this.logger.error(
            `${model} request failed (${err.name}): ${err.message}`,
          );
          if (
            err.name === 'AccessDeniedException' ||
            err.name === 'ResourceNotFoundException'
          ) {
            throw unavailable(model);
          }
          if (
            err.name === 'ValidationException' &&
            /too long|too many|context|exceed/i.test(err.message)
          ) {
            return { stop: 'too_long' };
          }
          throw serviceDown();
        }
        const usage = response.usage;
        this.logger.log(
          `${name} on ${model}: ${usage?.inputTokens ?? '?'} input, ${usage?.outputTokens ?? '?'} output tokens, stop: ${response.stopReason}`,
        );
        const message = response.output?.message;
        if (message) messages.push(message);
        const call = message?.content?.find(
          (b) => b.toolUse?.name === name,
        )?.toolUse;
        const stop = response.stopReason;
        return {
          stop:
            stop === 'guardrail_intervened' || stop === 'content_filtered'
              ? 'refusal'
              : stop === 'model_context_window_exceeded'
                ? 'too_long'
                : stop === 'tool_use' ||
                    stop === 'end_turn' ||
                    stop === 'max_tokens'
                  ? stop
                  : 'other',
          call: call?.toolUseId
            ? { id: call.toolUseId, input: call.input }
            : undefined,
        };
      },
      nudge: (text) => messages.push({ role: 'user', content: [{ text }] }),
      rejectToolCall: (id, text) =>
        messages.push({
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: id,
                status: 'error',
                content: [{ text }],
              },
            },
          ],
        }),
    };
  }
}
