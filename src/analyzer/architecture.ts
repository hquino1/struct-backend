import { z } from 'zod';
import { KEY_PART_KINDS } from '../docs/docs.entity.js';

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

export const FAQ_TOPICS = [
  'overview',
  'connections',
  'endpoints',
  'data',
  'deployment',
  'risks',
  'onboarding',
  'other',
] as const;

export const FaqResult = z.object({
  faq: z
    .array(
      z.object({
        question: z
          .string()
          .describe('The question, as worded in the instructions.'),
        answer: z
          .string()
          .describe(
            'Plain text: 2 to 5 sentences, or one intro line followed by lines starting with "- ".',
          ),
        topic: z
          .enum(FAQ_TOPICS)
          .describe(
            'Which listed question this answers; "other" for repository-specific questions.',
          ),
        componentIds: z
          .array(z.string())
          .describe(
            'ids of the components the answer is about, most relevant first.',
          ),
        paths: z
          .array(z.string())
          .describe(
            'Up to 4 repository files or directories the answer points to, relative to the repo root. Only paths that appear in the input.',
          ),
      }),
    )
    .describe(
      'Between 5 and 9 entries, in the order given in the instructions.',
    ),
});
export type FaqEntry = z.infer<typeof FaqResult>['faq'][number];

// Saved by runs before the FAQ replaced them; the API still returns them for those graphs.
export interface Insight {
  title: string;
  text: string;
  kind: 'Architecture' | 'Attention' | 'Best practice';
  componentIds: string[];
}

// The stored result, shaped for the frontend's graph view.
export interface ArchitectureGraph {
  components: (Component & { files: number })[];
  connections: Connection[];
  // Directory paths end in "/", so links can tell them from files. Missing on older runs.
  faq?: FaqEntry[];
  insights?: Insight[];
}

export const DocResult = z.object({
  summary: z
    .string()
    .describe('One sentence, under 25 words: what this file is for.'),
  purpose: z
    .string()
    .describe(
      "2 to 4 sentences on the file's role in the system: what calls it, what it relies on, and why it exists.",
    ),
  keyParts: z
    .array(
      z.object({
        name: z.string().describe('The identifier, e.g. "AnalysesService".'),
        kind: z.enum(KEY_PART_KINDS),
        description: z
          .string()
          .describe(
            'One or two sentences on what it does and when it is used.',
          ),
        line: z
          .number()
          .int()
          .describe(
            'The line number where it is defined, from the numbered input.',
          ),
      }),
    )
    .describe('Up to 10 of the most important definitions, in file order.'),
  notes: z
    .array(z.string())
    .describe(
      'Up to 4 things to know before changing this file. Empty when nothing stands out.',
    ),
});
