import type { ViewField } from '../view-graph.js';

// What each schema source reports: tables, collections, or key-value item types, and the
// relations between them.

export type EntityKind = 'table' | 'collection' | 'item';

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  // The database it lives in, e.g. "PostgreSQL" or "DynamoDB · projects table".
  store: string;
  fields: ViewField[];
  path: string;
  // True when a model read it from code rather than it being parsed from a schema.
  inferred?: boolean;
}

// Drawn from the side holding the reference (the foreign key) to the side it points at.
export interface Relation {
  from: string;
  to: string;
  label: '1:1' | 'N:1' | 'N:M';
}

export interface Schema {
  entities: Entity[];
  relations: Relation[];
}

// Marks a field as a key without demoting a stronger one (a primary key that is also a
// foreign key stays primary).
const KEY_RANK = {
  partition: 4,
  primary: 3,
  sort: 2,
  foreign: 1,
  unique: 0,
} as const;
export function markKey(field: ViewField, key: NonNullable<ViewField['key']>) {
  if (!field.key || KEY_RANK[key] > KEY_RANK[field.key]) field.key = key;
}
