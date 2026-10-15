import { z } from 'zod';
import { SCHEMA_SYSTEM } from '../../prompts.js';
import { readText } from '../../repo-digest.js';
import type { ViewContext } from '../view-graph.js';
import type { Schema } from './model.js';

// Data models defined in code rather than a schema file: ORM classes, Mongoose schemas,
// Drizzle tables, and DynamoDB single-table designs (whose "schema" is only the key
// builders). Matching files are found by pattern, and the model reads only those.

const SOURCE = /\.([cm]?[jt]sx?|py|rb|go|java|kt|cs)$/;
const TEST = /\.(spec|test)\.|(^|\/)(tests?|__tests__|__mocks__|fixtures?)\//;

const PATTERNS = [
  /@Entity\b/, // TypeORM, JPA
  /\bsequelize\.define\(|\bextends\s+Model\b.*\{[\s\S]{0,400}\.init\(/,
  /\bmodels\.Model\b/, // Django
  /declarative_base|DeclarativeBase|__tablename__|SQLModel,\s*table\s*=\s*True/, // SQLAlchemy
  /new\s+(?:mongoose\.)?Schema\s*[(<]|mongoose\.model\s*[(<]/, // Mongoose
  /\b(?:pgTable|mysqlTable|sqliteTable)\s*\(/, // Drizzle
  /<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/, // Rails
  /\bgorm\.Model\b/,
  // DynamoDB single-table designs: composite key builders like `USER#${id}`.
  /[`'"][A-Z][A-Z_]*#\$\{|\bKeyConditionExpression\b/,
];
const RAILS_SCHEMA = /(^|\/)db\/schema\.rb$/;

const MAX_FILE_CHARS = 12_000;
// About 40K input tokens: enough for a typical models folder.
const BUDGET_CHARS = 160_000;
const MAX_ENTITIES = 40;

export const SchemaResult = z.object({
  entities: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .describe('Short kebab-case identifier, unique in this list.'),
        name: z
          .string()
          .describe(
            'The table, collection, or item type name, e.g. "orders" or "Project".',
          ),
        kind: z
          .enum(['table', 'collection', 'item'])
          .describe(
            'table = relational table; collection = document store collection; item = an entity type stored in a key-value or single-table design (e.g. DynamoDB).',
          ),
        store: z
          .string()
          .describe(
            'Where it lives, e.g. "PostgreSQL", "MongoDB", or "DynamoDB · projects table" (name the physical table for single-table designs).',
          ),
        fields: z
          .array(
            z.object({
              name: z.string(),
              type: z
                .string()
                .describe('The field type as declared, kept short.'),
              key: z
                .enum([
                  'primary',
                  'foreign',
                  'partition',
                  'sort',
                  'unique',
                  'none',
                ])
                .describe(
                  'partition/sort for DynamoDB-style key attributes, with their key pattern in `type` (e.g. "USER#<userId>").',
                ),
            }),
          )
          .describe('The stored fields, keys first. At most 25.'),
        path: z.string().describe('The file that defines it, as given.'),
      }),
    )
    .describe(
      `Every persisted entity the code defines, at most ${MAX_ENTITIES}.`,
    ),
  relations: z
    .array(
      z.object({
        from: z.string().describe('id of the entity holding the reference.'),
        to: z.string().describe('id of the entity it references.'),
        label: z.enum(['1:1', 'N:1', 'N:M']),
      }),
    )
    .describe(
      'Relations the code declares or the key design implies (e.g. items sharing a partition key prefix).',
    ),
});

// Files that define data models, in path order, skipping any that would overrun the budget.
async function candidates({ repoDir, paths }: ViewContext) {
  const found: { path: string; text: string }[] = [];
  let used = 0;
  for (const path of paths.filter(
    (p) => (SOURCE.test(p) || RAILS_SCHEMA.test(p)) && !TEST.test(p),
  )) {
    const text = await readText(repoDir, path, 256_000).catch(() => undefined);
    if (
      !text ||
      !(RAILS_SCHEMA.test(path) || PATTERNS.some((p) => p.test(text)))
    )
      continue;
    const excerpt = text.slice(0, MAX_FILE_CHARS);
    if (used + excerpt.length > BUDGET_CHARS) continue;
    used += excerpt.length;
    found.push({ path, text: excerpt });
  }
  return found;
}

export async function inferredSchema(context: ViewContext): Promise<Schema> {
  const files = await candidates(context);
  if (!files.length) return { entities: [], relations: [] };

  const { entities, relations } = await context.llm.callTool({
    system: SCHEMA_SYSTEM,
    prompt: files
      .map((f) => `<file path="${f.path}">\n${f.text}\n</file>`)
      .join('\n\n'),
    tool: {
      name: 'record_schema',
      description: 'Record the data model defined in this code.',
      schema: SchemaResult,
    },
    effort: 'medium',
  });

  const paths = new Set(files.map((f) => f.path));
  const unique = [...new Map(entities.map((e) => [e.id, e])).values()].slice(
    0,
    MAX_ENTITIES,
  );
  const ids = new Set(unique.map((e) => e.id));
  return {
    entities: unique.map((e) => ({
      id: `ai:${e.id}`,
      name: e.name,
      kind: e.kind,
      store: e.store,
      fields: e.fields
        .slice(0, 25)
        .map(({ key, ...f }) => (key === 'none' ? f : { ...f, key })),
      // Only a path it was shown; anything else would link to a file that may not exist.
      path: paths.has(e.path) ? e.path : files[0]!.path,
      inferred: true,
    })),
    relations: relations
      .filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to)
      .map((r) => ({ from: `ai:${r.from}`, to: `ai:${r.to}`, label: r.label })),
  };
}
