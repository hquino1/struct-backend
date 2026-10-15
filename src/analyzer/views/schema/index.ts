import { componentLocator } from '../../repo-digest.js';
import type { ViewExtractor, ViewGraph, ViewNode } from '../view-graph.js';
import { inferredSchema } from './inferred.js';
import type { Schema } from './model.js';
import { prismaSchema } from './prisma.js';
import { sqlSchema } from './sql.js';

// The database schema: tables, collections, or item types with their fields, and the
// relations between them. Schema files (Prisma, SQL migrations) are parsed; only when there
// are none does a model read the data models defined in code.

const APPLIES = /\.(prisma|sql|[cm]?[jt]sx?|py|rb|go|java|kt|cs)$/;
const MAX_ENTITIES = 150;
const MAX_FIELDS = 40;

export const schemaExtractor: ViewExtractor = {
  view: 'schema',
  applies: (paths) => paths.some((p) => APPLIES.test(p)),

  async extract(context) {
    const prisma = await prismaSchema(context.repoDir, context.paths);
    const sql = await sqlSchema(context.repoDir, context.paths);
    // Prisma keeps its own migrations as SQL; the schema file is the cleaner of the two.
    const parsed: Schema = prisma.entities.length ? prisma : sql;
    const schema = parsed.entities.length
      ? parsed
      : await inferredSchema(context);

    const locate = componentLocator(context.components);
    const entities = schema.entities.slice(0, MAX_ENTITIES);
    const nodes: ViewNode[] = entities.map((e) => {
      const componentId = locate(e.path);
      const fields = e.fields.length;
      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        detail: [
          e.store,
          `${fields} ${fields === 1 ? 'field' : 'fields'}`,
          e.inferred && 'read from code by AI',
        ]
          .filter(Boolean)
          .join(' · '),
        group: e.store,
        path: e.path,
        fields: e.fields.slice(0, MAX_FIELDS),
        ...(componentId && { componentId }),
      };
    });
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      edges: schema.relations.filter(
        (r) => r.from !== r.to && ids.has(r.from) && ids.has(r.to),
      ),
    } satisfies ViewGraph;
  },
};
