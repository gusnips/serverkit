/**
 * Database types from a live Postgres schema, with no Docker and no Supabase CLI.
 *
 * Ten repos wrote this generator, in four lineages, and every copy mapped every Postgres type to
 * the same TypeScript type. They differed in coverage (enums, foreign keys, views) and in what
 * they exported. This is their union, in two shapes:
 *
 * - `supabase`: the `Database` type supabase-js reads (Row, Insert, Update, Relationships, Views,
 *   Functions, Enums, CompositeTypes) plus `Tables`, `TablesInsert`, `TablesUpdate` and `Enums`.
 * - `rows`: only what `SELECT *` returns, for code on raw `pg`: `Tables` and `TableName`.
 *
 * The output is one raw style (4-space indent, double quotes) with a static header and no
 * timestamp, so a regeneration against an unchanged schema is byte-identical. Formatting belongs
 * to the adopter: their prettier config and version decide the final bytes, so `db-types` takes a
 * `--format` command rather than bundling a formatter.
 *
 * ponytail: columns come from `information_schema`, not `pg_catalog`, because matching the old
 * generators byte for byte is the proof this package works. It has two known ceilings. It lists
 * only what the connecting role has a privilege on, and it has no materialized views. No repo on
 * the stack has a materialized view today; switch to `pg_attribute` when one does.
 */
import { Client } from "pg";
import { pgSsl } from "./ssl.ts";

export type TypesShape = "supabase" | "rows";

export interface TypesOptions {
  databaseUrl: string;
  /** Default `app`. */
  schema?: string;
  /** Default `supabase`. */
  shape?: TypesShape;
}

export interface GeneratedTypes {
  text: string;
  tables: number;
  views: number;
  enums: number;
  /** Postgres types with no mapping. Their columns are typed `string`. */
  unmapped: string[];
}

export interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_identity: "YES" | "NO";
  identity_generation: "ALWAYS" | "BY DEFAULT" | null;
  is_generated: "NEVER" | "ALWAYS";
  data_type: string;
  udt_name: string;
}

export interface Relationship {
  fkName: string;
  columns: string[];
  referencedRelation: string;
  referencedColumns: string[];
}

export interface Catalog {
  tables: Map<string, ColumnRow[]>;
  views: Map<string, ColumnRow[]>;
  enums: Map<string, string[]>;
  relationships: Map<string, Relationship[]>;
}

export async function generateTypes(options: TypesOptions): Promise<GeneratedTypes> {
  const schema = options.schema ?? "app";
  const client = new Client({
    connectionString: options.databaseUrl,
    ...pgSsl(options.databaseUrl),
    application_name: "@gusnips/migrate db-types",
  });
  await client.connect();
  try {
    const catalog = await readCatalog(client, schema);
    return renderTypes(catalog, schema, options.shape ?? "supabase");
  } finally {
    await client.end();
  }
}

export async function readCatalog(client: Client, schema: string): Promise<Catalog> {
  // Labels in declaration order, which is the order Postgres compares them in.
  const { rows: enumRows } = await client.query<{ enum_name: string; label: string }>(
    `SELECT t.typname AS enum_name, e.enumlabel AS label
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1
      ORDER BY t.typname, e.enumsortorder`,
    [schema],
  );
  const enums = new Map<string, string[]>();
  for (const row of enumRows)
    enums.set(row.enum_name, [...(enums.get(row.enum_name) ?? []), row.label]);

  const columnsOf = async (tableType: "BASE TABLE" | "VIEW") => {
    // Column order is ordinal position, which is the database's history rather than the text of
    // the migrations: a column added later sorts last even if a dump would put it elsewhere.
    const { rows } = await client.query<ColumnRow>(
      `SELECT c.table_name, c.column_name, c.is_nullable, c.column_default,
              c.is_identity, c.identity_generation, c.is_generated, c.data_type, c.udt_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = $1 AND t.table_type = $2
        ORDER BY c.table_name, c.ordinal_position`,
      [schema, tableType],
    );
    const byTable = new Map<string, ColumnRow[]>();
    for (const row of rows)
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row]);
    return byTable;
  };

  // Outgoing foreign keys per table. supabase-js reads them to type embedded selects in both
  // directions. `unnest … WITH ORDINALITY` pairs each column with the column it references.
  //
  // Only keys whose target is in this schema. A relationship names its target by bare relation
  // name, so `REFERENCES auth.users` used to read as a relationship to `users` here: a
  // self-relationship of app.users where that table exists, a relation that does not exist where
  // it does not. Both typecheck an embed PostgREST then refuses.
  const { rows: fkRows } = await client.query<{
    table_name: string;
    fk_name: string;
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
  }>(
    `SELECT con.conname AS fk_name,
            cl.relname AS table_name,
            att.attname AS column_name,
            clf.relname AS foreign_table_name,
            attf.attname AS foreign_column_name
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_class clf ON clf.oid = con.confrelid
       JOIN pg_namespace nsf ON nsf.oid = clf.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS lk(attnum, ord) ON true
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = lk.attnum
       JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = lk.ord
       JOIN pg_attribute attf ON attf.attrelid = con.confrelid AND attf.attnum = fk.attnum
      WHERE con.contype = 'f' AND ns.nspname = $1 AND nsf.nspname = $1
      ORDER BY cl.relname, con.conname, lk.ord`,
    [schema],
  );
  const byFk = new Map<string, Map<string, Relationship>>();
  for (const row of fkRows) {
    const forTable = byFk.get(row.table_name) ?? new Map<string, Relationship>();
    const relationship = forTable.get(row.fk_name) ?? {
      fkName: row.fk_name,
      columns: [],
      referencedRelation: row.foreign_table_name,
      referencedColumns: [],
    };
    relationship.columns.push(row.column_name);
    relationship.referencedColumns.push(row.foreign_column_name);
    forTable.set(row.fk_name, relationship);
    byFk.set(row.table_name, forTable);
  }
  const relationships = new Map<string, Relationship[]>();
  for (const [table, forTable] of byFk) relationships.set(table, [...forTable.values()]);

  return {
    tables: await columnsOf("BASE TABLE"),
    views: await columnsOf("VIEW"),
    enums,
    relationships,
  };
}

/**
 * Postgres `udt_name` to TypeScript, with PostgREST's JSON semantics: numbers as numbers, json as
 * `Json`, nearly everything else as a string.
 *
 * `money` is a string: its text form is `$1,000.00`, which is not a JSON number. A `rows`
 * consumer on raw `pg` gets strings for `int8` and `numeric` and a `Date` for timestamps unless it
 * installs type parsers; the adopters on raw `pg` either install them or coerce in their mappers,
 * and a driver-true mapping would break the first group, so there is one mapping.
 */
const SCALAR_MAP: Record<string, string> = {
  bool: "boolean",
  int2: "number",
  int4: "number",
  int8: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  money: "string",
  oid: "number",
  json: "Json",
  jsonb: "Json",
  text: "string",
  varchar: "string",
  bpchar: "string",
  char: "string",
  citext: "string",
  name: "string",
  uuid: "string",
  bytea: "string",
  date: "string",
  timestamp: "string",
  timestamptz: "string",
  time: "string",
  timetz: "string",
  interval: "string",
  inet: "string",
  cidr: "string",
  macaddr: "string",
  macaddr8: "string",
  tsvector: "string",
  tsquery: "string",
  vector: "string",
  halfvec: "string",
  xml: "string",
  bit: "string",
  varbit: "string",
  point: "string",
  line: "string",
  lseg: "string",
  box: "string",
  path: "string",
  polygon: "string",
  circle: "string",
};

const COL = " ".repeat(20);
const SUB = " ".repeat(16);
const TBL = " ".repeat(12);
const NEVER = `${TBL}[_ in never]: never;`;

export function renderTypes(catalog: Catalog, schema: string, shape: TypesShape): GeneratedTypes {
  const unmapped = new Set<string>();

  const scalar = (udt: string): string => {
    // An enum column points at the Enums map, so a new label lands in every column that uses it.
    if (catalog.enums.has(udt))
      return `Database[${JSON.stringify(schema)}]["Enums"][${JSON.stringify(udt)}]`;
    const mapped = SCALAR_MAP[udt];
    if (mapped) return mapped;
    unmapped.add(udt);
    return "string";
  };
  // An array column's udt_name is its element type with a leading underscore.
  const tsType = (column: ColumnRow) =>
    column.data_type === "ARRAY"
      ? `${scalar(column.udt_name.replace(/^_/, ""))}[]`
      : scalar(column.udt_name);
  const nullable = (column: ColumnRow) => (column.is_nullable === "YES" ? " | null" : "");
  const fields = (
    columns: ColumnRow[],
    optional: (column: ColumnRow) => boolean,
    forWrite = false,
  ) =>
    columns
      .map((column) =>
        // Postgres refuses a value for a generated column and for an identity column that is
        // GENERATED ALWAYS ("cannot insert a non-DEFAULT value"). Typed `?: T`, a write of one
        // typechecked and failed at runtime; `?: never` refuses it at compile time.
        forWrite && (column.is_generated === "ALWAYS" || column.identity_generation === "ALWAYS")
          ? `${COL}${key(column.column_name)}?: never;`
          : `${COL}${key(column.column_name)}${optional(column) ? "?" : ""}: ${tsType(column)}${nullable(column)};`,
      )
      .join("\n");

  const renderTable = (name: string, columns: ColumnRow[]) => {
    const row = fields(columns, () => false);
    if (shape === "rows") return `${TBL}${key(name)}: {\n${SUB}Row: {\n${row}\n${SUB}};\n${TBL}};`;

    const insert = fields(
      columns,
      (column) =>
        column.is_nullable === "YES" ||
        column.column_default !== null ||
        column.is_identity === "YES" ||
        column.is_generated === "ALWAYS",
      true,
    );
    const update = fields(columns, () => true, true);
    return `${TBL}${key(name)}: {
${SUB}Row: {
${row}
${SUB}};
${SUB}Insert: {
${insert}
${SUB}};
${SUB}Update: {
${update}
${SUB}};
${SUB}Relationships: ${renderRelationships(catalog.relationships.get(name) ?? [])};
${TBL}};`;
  };

  // Views are read models: a Row shape only. supabase-js still wants an (empty) Relationships array.
  // information_schema reports every view column as nullable, which is all Postgres can tell.
  const renderView = (name: string, columns: ColumnRow[]) =>
    shape === "rows"
      ? `${TBL}${key(name)}: {\n${SUB}Row: {\n${fields(columns, () => false)}\n${SUB}};\n${TBL}};`
      : `${TBL}${key(name)}: {\n${SUB}Row: {\n${fields(columns, () => false)}\n${SUB}};\n${SUB}Relationships: [];\n${TBL}};`;

  const tableNames = [...catalog.tables.keys()].sort();
  const viewNames = [...catalog.views.keys()].sort();
  const enumNames = [...catalog.enums.keys()].sort();
  const tables = tableNames
    .map((name) => renderTable(name, catalog.tables.get(name) ?? []))
    .join("\n");
  const views = viewNames.length
    ? viewNames.map((name) => renderView(name, catalog.views.get(name) ?? [])).join("\n")
    : NEVER;
  const enums = enumNames.length
    ? enumNames
        .map(
          (name) =>
            `${TBL}${key(name)}: ${(catalog.enums.get(name) ?? []).map((label) => JSON.stringify(label)).join(" | ")};`,
        )
        .join("\n")
    : NEVER;

  const alias = `${schema.charAt(0).toUpperCase()}${schema.slice(1)}Schema`;
  const header = `// ---------------------------------------------------------------------------
// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Regenerate after a schema change with \`gusnips-migrate db-types\`.
// Source: live Postgres \`${schema}\` schema, shape \`${shape}\`.
// ---------------------------------------------------------------------------

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
`;

  const text =
    shape === "rows"
      ? `${header}
export type Database = {
    ${key(schema)}: {
        Tables: {
${tables}
        };
        Views: {
${views}
        };
        Enums: {
${enums}
        };
    };
};

type ${alias} = Database[${JSON.stringify(schema)}];

export type TableName = keyof ${alias}["Tables"];
export type Tables<T extends TableName> = ${alias}["Tables"][T]["Row"];
`
      : `${header}
export type Database = {
    ${key(schema)}: {
        Tables: {
${tables}
        };
        Views: {
${views}
        };
        Functions: {
            // Permissive: rpc / stored-procedure calls are typed loosely (any
            // valid name; the unknown result is narrowed at the call site, the
            // rpc boundary). Replace with generated signatures for precise typing.
            [key: string]: {
                Args: Record<string, unknown>;
                Returns: unknown;
            };
        };
        Enums: {
${enums}
        };
        CompositeTypes: {
            [_ in never]: never;
        };
    };
};

type ${alias} = Database[${JSON.stringify(schema)}];

export type Tables<T extends keyof ${alias}["Tables"]> = ${alias}["Tables"][T]["Row"];
export type TablesInsert<T extends keyof ${alias}["Tables"]> = ${alias}["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof ${alias}["Tables"]> = ${alias}["Tables"][T]["Update"];
export type Enums<T extends keyof ${alias}["Enums"]> = ${alias}["Enums"][T];
`;

  return {
    text,
    tables: tableNames.length,
    views: viewNames.length,
    enums: enumNames.length,
    unmapped: [...unmapped].sort(),
  };
}

function renderRelationships(relationships: Relationship[]): string {
  if (relationships.length === 0) return "[]";
  // isOneToOne stays false: every embed on the stack is many-to-one, and a to-one embed resolves
  // to an object either way. Revisit when a unique foreign key needs its reverse embed typed as one.
  const items = relationships
    .map(
      (r) =>
        `${COL}{ foreignKeyName: ${JSON.stringify(r.fkName)}; columns: [${r.columns.map((c) => JSON.stringify(c)).join(", ")}]; isOneToOne: false; referencedRelation: ${JSON.stringify(r.referencedRelation)}; referencedColumns: [${r.referencedColumns.map((c) => JSON.stringify(c)).join(", ")}]; }`,
    )
    .join(",\n");
  return `[\n${items},\n${SUB}]`;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function key(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}
