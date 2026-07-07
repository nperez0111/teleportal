/**
 * A single result row. Both `postgres` (porsager) and `Bun.sql` return
 * plain objects keyed by column name.
 */
export type Row = Record<string, unknown>;

/**
 * A reserved (pool-pinned) connection. Queries issued through it run on one
 * dedicated session until {@link ReservedSql.release} returns it to the pool.
 */
export interface ReservedSql extends Sql {
  release(): void;
}

/**
 * Minimal structural interface for a Postgres client. Satisfied by both
 * `postgres` (porsager/postgres) and Bun's built-in `Bun.sql` / `new SQL()`,
 * so neither is a hard dependency — construct whichever client you like and
 * inject it:
 *
 * ```ts
 * import postgres from "postgres";
 * const sql = postgres("postgres://localhost/mydb");
 *
 * // or, on Bun, with zero dependencies:
 * import { SQL } from "bun";
 * const sql = new SQL("postgres://localhost/mydb");
 * ```
 *
 * The adapters never call `end()` — the connection pool's lifecycle belongs
 * to the caller.
 */
export interface Sql {
  <T = Row[]>(strings: TemplateStringsArray, ...params: unknown[]): PromiseLike<T>;

  /** Run a raw query string (used only for DDL — never with user input). */
  unsafe(query: string, params?: unknown[]): PromiseLike<unknown>;

  /** Run `cb` inside BEGIN/COMMIT on a dedicated connection. */
  begin<T>(cb: (sql: Sql) => Promise<T>): PromiseLike<T>;

  /** Pull a dedicated connection out of the pool. */
  reserve(): PromiseLike<ReservedSql>;
}

/**
 * Normalize a `bytea` column value to a plain `Uint8Array` view. porsager
 * returns Node `Buffer`s, Bun returns `Uint8Array`s — re-wrapping the Buffer
 * (zero-copy) keeps prototypes and equality checks consistent downstream.
 */
export function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value.constructor === Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`Expected bytea value, got ${typeof value}`);
}

/**
 * Build a `TemplateStringsArray` from raw string parts. Query templates are
 * built once per adapter instance (the table prefix is baked into the parts),
 * giving them stable identity so clients that cache prepared statements by
 * template can reuse them.
 */
export function tpl(parts: readonly string[]): TemplateStringsArray {
  const arr = [...parts] as string[] & { raw: readonly string[] };
  arr.raw = parts;
  return Object.freeze(arr) as unknown as TemplateStringsArray;
}
