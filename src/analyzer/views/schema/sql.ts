import { readConfig } from '../shared.js';
import type { ViewField } from '../view-graph.js';
import { markKey, type Schema } from './model.js';

// SQL schema files and migrations, replayed in path order (migration folders sort by
// timestamp), so the result is the schema after the last migration: CREATE TABLE, ALTER
// TABLE ADD/DROP COLUMN and ADD FOREIGN KEY, and DROP TABLE.

const SQL_FILE = /\.sql$/i;
// Seed and fixture files are data, not schema, and can be huge.
const SKIP = /(^|\/)(seeds?|fixtures?|dumps?|test[s]?)(\/|[._-])/i;
const MAX_FILES = 400;

interface Table {
  name: string;
  path: string;
  fields: ViewField[];
  // Column -> referenced table key.
  references: Map<string, string>;
  // Columns unique on their own (a single-column primary key or UNIQUE), for 1:1 relations.
  unique: Set<string>;
}

// `public."Orders"` -> `orders` for matching, `Orders` for display.
const display = (raw: string) =>
  raw
    .split('.')
    .pop()!
    .replace(/^[`"[]|[`"\]]$/g, '');
const keyOf = (raw: string) => display(raw).toLowerCase();

// Splits on commas outside parentheses (types like NUMERIC(10, 2), multi-column keys).
function splitTopLevel(body: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// The text inside the parentheses that open at or after `from`.
function parenthesized(text: string, from: number) {
  const open = text.indexOf('(', from);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return undefined;
}

const columns = (list: string) => list.split(',').map((c) => keyOf(c.trim()));
const NAME = String.raw`([\w$]+(?:\.[\w$]+)?|"[^"]+"(?:\."[^"]+")?|\`[^\`]+\`|\[[^\]]+\])`;
const REFERENCES = new RegExp(String.raw`REFERENCES\s+${NAME}`, 'i');
const TABLE_CONSTRAINT =
  /^(CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|INDEX|KEY|EXCLUDE|FULLTEXT|SPATIAL)\b/i;

function applyItem(table: Table, item: string) {
  const constraint = TABLE_CONSTRAINT.exec(item);
  if (constraint) {
    const kind = constraint[2]!.toUpperCase().replace(/\s+/g, ' ');
    const cols = columns(parenthesized(item, constraint[0].length) ?? '');
    const field = (c: string) =>
      table.fields.find((f) => f.name.toLowerCase() === c);
    if (kind === 'PRIMARY KEY' || kind === 'UNIQUE') {
      if (cols.length === 1) table.unique.add(cols[0]!);
      for (const c of cols) {
        if (field(c))
          markKey(field(c)!, kind === 'UNIQUE' ? 'unique' : 'primary');
      }
    } else if (kind === 'FOREIGN KEY') {
      const target = REFERENCES.exec(item)?.[1];
      for (const c of cols) {
        if (target) table.references.set(c, keyOf(target));
        if (field(c)) markKey(field(c)!, 'foreign');
      }
    }
    return;
  }
  // A column: name, type, then constraints.
  const m = new RegExp(String.raw`^${NAME}\s+(.+)$`, 's').exec(item);
  if (!m) return;
  const name = display(m[1]!);
  const rest = m[2]!;
  const type = (
    /^([\w ]+?(?:\([^)]*\))?(?:\[\])?)(?=\s+(?:NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|CONSTRAINT|GENERATED|AUTO_INCREMENT|COLLATE|ON|IDENTITY)\b|\s*$)/i.exec(
      rest.trim(),
    )?.[1] ?? rest.split(/\s+/)[0]!
  ).trim();
  const field: ViewField = { name, type: type.toLowerCase() };
  if (/PRIMARY\s+KEY/i.test(rest)) markKey(field, 'primary');
  if (/\bUNIQUE\b/i.test(rest)) markKey(field, 'unique');
  if (field.key) table.unique.add(name.toLowerCase());
  const target = REFERENCES.exec(rest)?.[1];
  if (target) {
    markKey(field, 'foreign');
    table.references.set(name.toLowerCase(), keyOf(target));
  }
  table.fields = table.fields.filter(
    (f) => f.name.toLowerCase() !== name.toLowerCase(),
  );
  table.fields.push(field);
}

// A guess at the dialect from syntax only one of them uses.
function dialect(sql: string) {
  if (/\bSERIAL\b|\bJSONB\b|\$\$|::\w|\bTIMESTAMPTZ\b|\bUUID\b/i.test(sql))
    return 'PostgreSQL';
  if (/AUTO_INCREMENT|ENGINE\s*=|`/i.test(sql)) return 'MySQL';
  if (/AUTOINCREMENT|\bPRAGMA\b/i.test(sql)) return 'SQLite';
  if (/\bIDENTITY\s*\(|\bNVARCHAR\b|\[dbo\]/i.test(sql)) return 'SQL Server';
  return 'SQL database';
}

export async function sqlSchema(
  repoDir: string,
  paths: string[],
): Promise<Schema> {
  const tables = new Map<string, Table>();
  let allSql = '';
  const files = paths
    .filter((p) => SQL_FILE.test(p) && !SKIP.test(p))
    .slice(0, MAX_FILES);
  for (const path of files) {
    const source = await readConfig(repoDir, path);
    if (!source) continue;
    const sql = source
      .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''") // function bodies hold semicolons
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
    allSql += sql;
    for (const statement of sql.split(';')) {
      const s = statement.trim();
      const create = new RegExp(
        String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+)?(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
        'i',
      ).exec(s);
      if (create) {
        const body = parenthesized(s, create[0].length);
        if (body === undefined) continue;
        const table: Table = {
          name: display(create[1]!),
          path,
          fields: [],
          references: new Map(),
          unique: new Set(),
        };
        // Columns first, so table constraints can mark them.
        const items = splitTopLevel(body);
        items
          .filter((i) => !TABLE_CONSTRAINT.test(i))
          .forEach((i) => applyItem(table, i));
        items
          .filter((i) => TABLE_CONSTRAINT.test(i))
          .forEach((i) => applyItem(table, i));
        tables.set(keyOf(create[1]!), table);
        continue;
      }
      const alter = new RegExp(
        String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}\s+([\s\S]+)$`,
        'i',
      ).exec(s);
      if (alter) {
        const table = tables.get(keyOf(alter[1]!));
        if (!table) continue;
        for (const action of splitTopLevel(alter[2]!)) {
          const add =
            /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(
              action,
            );
          const drop = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(\S+)/i.exec(
            action,
          );
          if (add) applyItem(table, add[1]!);
          else if (
            drop &&
            !/^(CONSTRAINT|INDEX|KEY|PRIMARY|FOREIGN)$/i.test(drop[1]!)
          ) {
            const column = keyOf(drop[1]!);
            table.fields = table.fields.filter(
              (f) => f.name.toLowerCase() !== column,
            );
            table.references.delete(column);
          }
        }
        continue;
      }
      const dropTable =
        /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+CASCADE|\s+RESTRICT)?$/i.exec(
          s,
        );
      if (dropTable) {
        for (const name of dropTable[1]!.split(','))
          tables.delete(keyOf(name.trim()));
      }
    }
  }

  const store = dialect(allSql);
  const schema: Schema = { entities: [], relations: [] };
  for (const [key, table] of tables) {
    schema.entities.push({
      id: `sql:${key}`,
      name: table.name,
      kind: 'table',
      store,
      fields: table.fields,
      path: table.path,
    });
    const seen = new Set<string>();
    for (const [column, target] of table.references) {
      if (!tables.has(target) || seen.has(target)) continue;
      seen.add(target);
      schema.relations.push({
        from: `sql:${key}`,
        to: `sql:${target}`,
        // A foreign key that is unique on its own means one-to-one.
        label: table.unique.has(column) ? '1:1' : 'N:1',
      });
    }
  }
  return schema;
}
