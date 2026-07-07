import type { Row, Sql } from "./types";

/**
 * Version of the table layout below. Bumped on incompatible layout changes;
 * {@link ensureSchema} fails loudly when it finds a different version instead
 * of letting adapters fail obscurely mid-query.
 */
export const SCHEMA_VERSION = 1;

export const DEFAULT_TABLE_PREFIX = "teleportal_";

const TABLE_PREFIX_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_TABLE_PREFIX_LENGTH = 40;

/**
 * Validate a table prefix so it is safe to interpolate into DDL/queries.
 * Returns the prefix unchanged.
 */
export function validateTablePrefix(prefix: string): string {
  if (!TABLE_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `Invalid table prefix "${prefix}": must match ${TABLE_PREFIX_PATTERN} ` +
        `(lowercase letters, digits and underscores, not starting with a digit)`,
    );
  }
  if (prefix.length > MAX_TABLE_PREFIX_LENGTH) {
    throw new Error(
      `Invalid table prefix "${prefix}": exceeds ${MAX_TABLE_PREFIX_LENGTH} characters`,
    );
  }
  return prefix;
}

export const TABLE_NAMES = [
  "schema_meta",
  "documents",
  "pending_updates",
  "attributions",
  "milestones",
  "rate_limits",
  "key_registry",
  "key_registry_meta",
] as const;

/**
 * Build the DDL statements for the given table prefix. All statements are
 * `IF NOT EXISTS` and safe to run on every startup.
 *
 * Design notes:
 * - Every table is queried exclusively via its composite primary key, so no
 *   secondary indexes exist — appends stay single-index writes.
 * - Binary payloads are `bytea` (no base64/hex overhead); pending updates and
 *   sidecars use the lib0 codec in `./codec.ts`.
 * - Timestamps are `double precision` holding `Date.now()` milliseconds
 *   (float64-exact), avoiding int8-to-string conversions in clients.
 * - `rate_limits` is UNLOGGED: token buckets are reconstructible, so skipping
 *   WAL is a deliberate durability trade for per-message write speed.
 */
export function buildSchemaSql(tablePrefix: string = DEFAULT_TABLE_PREFIX): string[] {
  const p = validateTablePrefix(tablePrefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${p}schema_meta (
      id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      version integer NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}documents (
      document_id text PRIMARY KEY,
      update_data bytea,
      sidecars bytea,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}pending_updates (
      document_id text NOT NULL,
      id bigint GENERATED ALWAYS AS IDENTITY,
      payload bytea NOT NULL,
      PRIMARY KEY (document_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}attributions (
      document_id text NOT NULL,
      id bigint GENERATED ALWAYS AS IDENTITY,
      content_map bytea NOT NULL,
      PRIMARY KEY (document_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}milestones (
      document_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      created_at double precision NOT NULL,
      created_by_type text NOT NULL,
      created_by_id text NOT NULL,
      lifecycle_state text NOT NULL DEFAULT 'active',
      deleted_at double precision,
      deleted_by text,
      retention_policy_id text,
      expires_at double precision,
      snapshot bytea NOT NULL,
      PRIMARY KEY (document_id, id)
    )`,
    `CREATE UNLOGGED TABLE IF NOT EXISTS ${p}rate_limits (
      key text PRIMARY KEY,
      tokens double precision NOT NULL,
      last_refill double precision NOT NULL,
      window_ms double precision NOT NULL,
      max_messages double precision NOT NULL,
      expires_at double precision NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}key_registry (
      document_id text NOT NULL,
      user_id text NOT NULL,
      wrapped_key bytea NOT NULL,
      PRIMARY KEY (document_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}key_registry_meta (
      document_id text PRIMARY KEY,
      generation integer NOT NULL DEFAULT 0
    )`,
  ];
}

/**
 * The default-prefix DDL as one script, for users who run their own
 * migration tooling instead of {@link ensureSchema}.
 */
export const SCHEMA_SQL = `${buildSchemaSql().join(";\n\n")};\n\nINSERT INTO ${DEFAULT_TABLE_PREFIX}schema_meta (id, version) VALUES (1, ${SCHEMA_VERSION}) ON CONFLICT (id) DO NOTHING;`;

export interface SchemaOptions {
  tablePrefix?: string;
}

/**
 * Create all tables (idempotent) and verify the schema version. Safe to call
 * on every startup. Throws when an existing schema has a different version.
 */
export async function ensureSchema(sql: Sql, options: SchemaOptions = {}): Promise<void> {
  const p = validateTablePrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  for (const statement of buildSchemaSql(p)) {
    await sql.unsafe(statement);
  }
  await sql.unsafe(
    `INSERT INTO ${p}schema_meta (id, version) VALUES (1, ${SCHEMA_VERSION}) ON CONFLICT (id) DO NOTHING`,
  );
  const rows = (await sql.unsafe(`SELECT version FROM ${p}schema_meta WHERE id = 1`)) as Row[];
  const version = Number(rows[0]?.version);
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Postgres schema version mismatch for prefix "${p}": found ${version}, ` +
        `this version of teleportal expects ${SCHEMA_VERSION}. ` +
        `Migrate the tables (or drop them via dropSchema) and re-run ensureSchema.`,
    );
  }
}

/**
 * Drop every table created by {@link ensureSchema}. Used by tests; also the
 * escape hatch after an incompatible schema version bump.
 */
export async function dropSchema(sql: Sql, options: SchemaOptions = {}): Promise<void> {
  const p = validateTablePrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  for (const table of TABLE_NAMES) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${p}${table}`);
  }
}
