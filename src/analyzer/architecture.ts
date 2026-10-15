import { z } from 'zod';

// What Claude returns at each step. Each schema doubles as a tool's input_schema, so the
// `.describe()` text is what Claude reads about each field.

export const COMPONENT_TYPES = [
  'frontend',
  'service',
  'data',
  'external',
] as const;

export const ComponentsResult = z.object({
  components: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .describe(
            'Short kebab-case identifier, unique in this list, e.g. "api-gateway".',
          ),
        name: z.string().describe('Human-readable name, e.g. "API Gateway".'),
        type: z
          .enum(COMPONENT_TYPES)
          .describe(
            'frontend = user-facing app or UI; service = backend code in this repo (API, worker, function); data = database, cache, queue, or storage; external = third-party API or SaaS.',
          ),
        tech: z
          .string()
          .describe(
            'Main technologies joined with " · ", e.g. "NestJS · TypeScript".',
          ),
        description: z
          .string()
          .describe(
            'One or two sentences on what the component does in this system.',
          ),
        paths: z
          .array(z.string())
          .describe(
            'Repository directories (or files) holding this component\'s code, relative to the repo root, without a leading "./". Empty for data stores and external services that have no code here.',
          ),
        entryPoint: z
          .string()
          .describe(
            'The most representative file to open first, relative to the repo root. Empty string when the component has no code here.',
          ),
      }),
    )
    .describe(
      'Between 2 and 20 components, the main building blocks of the system.',
    ),
});
export type Component = z.infer<typeof ComponentsResult>['components'][number];

export const ConnectionsResult = z.object({
  connections: z.array(
    z.object({
      from: z
        .string()
        .describe('id of the component that initiates the interaction.'),
      to: z.string().describe('id of the component it depends on or calls.'),
      label: z
        .string()
        .describe(
          'A few words naming the mechanism, e.g. "REST", "SQL", "imports", "Webhook".',
        ),
    }),
  ),
});
export type Connection = z.infer<
  typeof ConnectionsResult
>['connections'][number];

export const INSIGHT_KINDS = [
  'Architecture',
  'Attention',
  'Best practice',
] as const;

export const InsightsResult = z.object({
  insights: z
    .array(
      z.object({
        title: z.string().describe('Short headline, under 8 words.'),
        text: z
          .string()
          .describe(
            'One or two sentences naming the specific components involved.',
          ),
        kind: z
          .enum(INSIGHT_KINDS)
          .describe(
            'Architecture = notable structure; Attention = a risk or problem worth fixing; Best practice = something done well.',
          ),
        componentIds: z
          .array(z.string())
          .describe('ids of the components the insight is about.'),
      }),
    )
    .describe('Between 3 and 5 insights, most important first.'),
});
export type Insight = z.infer<typeof InsightsResult>['insights'][number];

// The stored result, shaped for the frontend's graph view.
export interface ArchitectureGraph {
  components: (Component & { files: number })[];
  connections: Connection[];
  insights: Insight[];
}
