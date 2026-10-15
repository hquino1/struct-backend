import { readConfig } from '../shared.js';
import type { ViewField } from '../view-graph.js';
import { markKey, type Entity, type Relation, type Schema } from './model.js';

// Prisma schemas: models become tables (or collections on MongoDB), and relation fields
// become relations. The side with `@relation(fields: [...])` holds the foreign key.

const SCALARS = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
]);
const PROVIDERS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
  cockroachdb: 'CockroachDB',
};

const BLOCK = /^\s*(model|enum|datasource)\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
const FIELD = /^\s*(\w+)\s+(\w+(?:\([^)]*\))?)(\[\])?(\?)?(.*)$/;

interface RelationField {
  model: string;
  target: string;
  list: boolean;
  // Holds the foreign key: names the local fields it stores.
  owns: boolean;
}

export async function prismaSchema(
  repoDir: string,
  paths: string[],
): Promise<Schema> {
  const schema: Schema = { entities: [], relations: [] };
  // Multi-file schemas (prisma/schema/*.prisma) share one namespace, so read them together.
  const blocks: { kind: string; name: string; body: string; path: string }[] =
    [];
  for (const path of paths.filter((p) => p.endsWith('.prisma'))) {
    const source = await readConfig(repoDir, path);
    if (!source) continue;
    for (const [, kind, name, body] of source.matchAll(BLOCK)) {
      blocks.push({ kind: kind!, name: name!, body: body!, path });
    }
  }
  if (!blocks.some((b) => b.kind === 'model')) return schema;

  const provider = blocks
    .filter((b) => b.kind === 'datasource')
    .map((b) => /provider\s*=\s*"(\w+)"/.exec(b.body)?.[1])
    .find(Boolean);
  const store = PROVIDERS[provider ?? ''] ?? 'Database';
  const enums = new Set(
    blocks.filter((b) => b.kind === 'enum').map((b) => b.name),
  );
  const models = new Set(
    blocks.filter((b) => b.kind === 'model').map((b) => b.name),
  );

  const relationFields: RelationField[] = [];
  for (const { name, body, path } of blocks.filter((b) => b.kind === 'model')) {
    const fields: ViewField[] = [];
    const foreign = new Set<string>();
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('@@id')) {
        for (const id of /\[([^\]]*)\]/.exec(trimmed)?.[1]?.split(',') ?? []) {
          const field = fields.find((f) => f.name === id.trim());
          if (field) markKey(field, 'primary');
        }
        continue;
      }
      const m = FIELD.exec(line);
      if (!m || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
      const [, fieldName, type, list, optional, rest] = m;
      if (models.has(type!)) {
        const owns = /@relation\([^)]*fields\s*:/.test(rest!);
        for (const local of /fields\s*:\s*\[([^\]]*)\]/
          .exec(rest!)?.[1]
          ?.split(',') ?? []) {
          foreign.add(local.trim());
        }
        relationFields.push({ model: name, target: type!, list: !!list, owns });
        continue;
      }
      if (!SCALARS.has(type!.replace(/\(.*/, '')) && !enums.has(type!))
        continue;
      const field: ViewField = {
        name: fieldName!,
        type: `${type}${list ?? ''}${optional ?? ''}`,
      };
      if (/@id\b/.test(rest!)) markKey(field, 'primary');
      if (/@unique\b/.test(rest!)) markKey(field, 'unique');
      fields.push(field);
    }
    for (const field of fields)
      if (foreign.has(field.name)) markKey(field, 'foreign');
    const entity: Entity = {
      id: `prisma:${name}`,
      name,
      kind: store === 'MongoDB' ? 'collection' : 'table',
      store,
      fields,
      path,
    };
    schema.entities.push(entity);
  }

  // One relation per pair of models: N:1 or 1:1 from the side holding the key, or N:M when
  // both sides are lists (Prisma's implicit join table).
  const seen = new Set<string>();
  for (const field of relationFields) {
    const back = relationFields.find(
      (f) =>
        f.model === field.target && f.target === field.model && f !== field,
    );
    const pair = [field.model, field.target].sort().join('|');
    let relation: Relation | undefined;
    if (field.owns) {
      relation = {
        from: `prisma:${field.model}`,
        to: `prisma:${field.target}`,
        label: back && !back.list ? '1:1' : 'N:1',
      };
    } else if (field.list && back?.list && field.model <= field.target) {
      relation = {
        from: `prisma:${field.model}`,
        to: `prisma:${field.target}`,
        label: 'N:M',
      };
    }
    if (relation && !seen.has(pair)) {
      seen.add(pair);
      schema.relations.push(relation);
    }
  }
  return schema;
}
