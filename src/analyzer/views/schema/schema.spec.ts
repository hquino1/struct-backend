import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Component } from '../../architecture.js';
import { listRepositoryFiles } from '../../repository.js';
import type { ViewContext, ViewGraph } from '../view-graph.js';
import { schemaExtractor } from './index.js';

const PRISMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id      String   @id @default(uuid())
  email   String   @unique
  role    Role
  posts   Post[]
  profile Profile?
  tags    Tag[]
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String?
  user   User   @relation(fields: [userId], references: [id])
  userId String @unique
}

model Post {
  id       Int    @id
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId String
}

model Tag {
  id    Int    @id
  users User[]
}

enum Role {
  USER
  ADMIN
}
`;

const MIGRATION_1 = `
-- Initial schema
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE "orders" (
  id SERIAL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total NUMERIC(10, 2) NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE legacy_audit (id SERIAL PRIMARY KEY);

CREATE FUNCTION touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

const MIGRATION_2 = `
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  CONSTRAINT invoices_order_unique UNIQUE (order_id)
);
ALTER TABLE invoices ADD CONSTRAINT invoices_order_fk FOREIGN KEY (order_id) REFERENCES orders (id);
ALTER TABLE orders ADD COLUMN status TEXT, DROP COLUMN total;
DROP TABLE IF EXISTS legacy_audit;
`;

const DYNAMO_ENTITY = `
export const userKey = (userId: string) => \`USER#\${userId}\`;
export const projectKey = (projectId: string) => \`PROJECT#\${projectId}\`;
export interface ProjectItem { PK: string; SK: string; name: string; }
`;

const component = (id: string, paths: string[]): Component => ({
  id,
  name: id,
  type: 'service',
  tech: '',
  description: '',
  paths,
  entryPoint: '',
});

describe('schemaExtractor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'struct-schema-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (path: string, content: string) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  const extract = async (
    llm: ViewContext['llm'] = {
      callTool: () => Promise.reject(new Error('unexpected model call')),
    },
    components: Component[] = [],
  ) =>
    schemaExtractor.extract({
      repoDir: dir,
      paths: await listRepositoryFiles(dir),
      components,
      facts: new Map(),
      llm,
    });

  const helpers = ({ nodes, edges }: ViewGraph) => ({
    node: (id: string) => nodes.find((n) => n.id === id),
    edge: (from: string, to: string) =>
      edges.find((e) => e.from === from && e.to === to),
  });

  it('parses a Prisma schema into tables, keys, and relations', async () => {
    await file('api/prisma/schema.prisma', PRISMA);
    await file('api/prisma/migrations/1_init/migration.sql', MIGRATION_1);
    const graph = await extract(undefined, [component('api', ['api'])]);
    const { node, edge } = helpers(graph);

    // The Prisma schema wins over its own generated migrations.
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      'prisma:Post',
      'prisma:Profile',
      'prisma:Tag',
      'prisma:User',
    ]);
    expect(node('prisma:User')).toMatchObject({
      kind: 'table',
      group: 'PostgreSQL',
      detail: 'PostgreSQL · 3 fields',
      componentId: 'api',
      path: 'api/prisma/schema.prisma',
      fields: [
        { name: 'id', type: 'String', key: 'primary' },
        { name: 'email', type: 'String', key: 'unique' },
        { name: 'role', type: 'Role' },
      ],
    });
    expect(node('prisma:Post')!.fields).toContainEqual({
      name: 'authorId',
      type: 'String',
      key: 'foreign',
    });
    expect(edge('prisma:Post', 'prisma:User')).toMatchObject({ label: 'N:1' });
    expect(edge('prisma:Profile', 'prisma:User')).toMatchObject({
      label: '1:1',
    });
    expect(edge('prisma:Tag', 'prisma:User')).toMatchObject({ label: 'N:M' });
  });

  it('replays SQL migrations in order', async () => {
    await file('db/migrations/001_init.sql', MIGRATION_1);
    await file('db/migrations/002_invoices.sql', MIGRATION_2);
    await file('db/seeds/data.sql', 'CREATE TABLE seed_only (id INT);');
    const graph = await extract();
    const { node, edge } = helpers(graph);

    expect(graph.nodes.map((n) => n.name).sort()).toEqual([
      'customers',
      'invoices',
      'orders',
    ]);
    expect(node('sql:orders')).toMatchObject({
      group: 'PostgreSQL',
      fields: [
        { name: 'id', type: 'serial', key: 'primary' },
        { name: 'customer_id', type: 'integer', key: 'foreign' },
        { name: 'status', type: 'text' },
      ],
    });
    expect(node('sql:customers')!.fields).toContainEqual({
      name: 'created_at',
      type: 'timestamptz',
    });
    expect(edge('sql:orders', 'sql:customers')).toMatchObject({ label: 'N:1' });
    // A unique foreign key added by ALTER TABLE is one-to-one.
    expect(edge('sql:invoices', 'sql:orders')).toMatchObject({ label: '1:1' });
  });

  it('asks the model only about files that define data models', async () => {
    await file('backend/src/projects/project.entity.ts', DYNAMO_ENTITY);
    await file(
      'backend/src/util/strings.ts',
      'export const trim = (s: string) => s.trim();',
    );
    const prompts: string[] = [];
    const llm: ViewContext['llm'] = {
      callTool: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve({
          entities: [
            {
              id: 'project',
              name: 'Project',
              kind: 'item',
              store: 'DynamoDB · projects table',
              fields: [
                { name: 'PK', type: 'USER#<userId>', key: 'partition' },
                { name: 'SK', type: 'PROJECT#<projectId>', key: 'sort' },
                { name: 'name', type: 'string', key: 'none' },
              ],
              path: 'backend/src/projects/project.entity.ts',
            },
            {
              id: 'user',
              name: 'User',
              kind: 'item',
              store: 'DynamoDB · projects table',
              fields: [],
              path: 'somewhere/else.ts',
            },
          ],
          relations: [
            { from: 'project', to: 'user', label: 'N:1' },
            { from: 'project', to: 'missing', label: 'N:1' },
          ],
        } as never);
      },
    };
    const graph = await extract(llm, [component('api', ['backend'])]);
    const { node, edge } = helpers(graph);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      '<file path="backend/src/projects/project.entity.ts">',
    );
    expect(prompts[0]).not.toContain('strings.ts');
    expect(node('ai:project')).toMatchObject({
      kind: 'item',
      group: 'DynamoDB · projects table',
      detail: 'DynamoDB · projects table · 3 fields · read from code by AI',
      componentId: 'api',
      fields: [
        { name: 'PK', type: 'USER#<userId>', key: 'partition' },
        { name: 'SK', type: 'PROJECT#<projectId>', key: 'sort' },
        { name: 'name', type: 'string' },
      ],
    });
    // A path the model wasn't shown falls back to one it was.
    expect(node('ai:user')!.path).toBe(
      'backend/src/projects/project.entity.ts',
    );
    expect(edge('ai:project', 'ai:user')).toMatchObject({ label: 'N:1' });
    expect(graph.edges).toHaveLength(1);
  });

  it('makes no model call when nothing looks like a data model', async () => {
    await file('src/main.ts', 'console.log("hello");');
    const { nodes } = await extract();
    expect(nodes).toEqual([]);
  });
});
