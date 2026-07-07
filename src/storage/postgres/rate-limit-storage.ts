import type { RateLimitState, RateLimitStorage } from "../types";
import { AdvisoryLocker } from "./lock";
import { DEFAULT_TABLE_PREFIX, validateTablePrefix } from "./schema";
import { tpl, type Row, type Sql } from "./types";

export interface PostgresRateLimitStorageOptions {
  /** Table prefix, matching the one given to `ensureSchema`. */
  tablePrefix?: string;
  /** Advisory-lock wait bound for `transaction()`. Defaults to 30s. */
  lockTimeoutMs?: number;
  /**
   * Chance that a `setState` call also sweeps expired rows, in `[0, 1]`.
   * Defaults to 0.01 — amortizes cleanup across the write path instead of
   * requiring a background job. Set to 0 to disable, 1 to sweep every write.
   */
  cleanupProbability?: number;
}

const DEFAULT_CLEANUP_PROBABILITY = 0.01;

/**
 * Token-bucket rate-limit state backed by Postgres.
 *
 * - Rows live in the UNLOGGED `rate_limits` table: buckets are
 *   reconstructible, so skipping WAL is a deliberate durability trade for
 *   per-message write speed.
 * - Expiry is app-clock based: writers stamp `expires_at` from `Date.now()`
 *   and readers compare against `Date.now()` too, so app/DB clock skew never
 *   changes a TTL. Expired rows read as absent immediately and are physically
 *   removed by a probabilistic sweep piggybacked on `setState`.
 * - `transaction()` is per-key mutual exclusion via {@link AdvisoryLocker}.
 *
 * Run `ensureSchema(sql, { tablePrefix })` once at startup. The injected
 * client can be `postgres` (porsager) or `Bun.sql`; the adapter never ends
 * the pool. Call {@link close} to release the dedicated lock connection.
 */
export class PostgresRateLimitStorage implements RateLimitStorage {
  readonly #sql: Sql;
  readonly #locker: AdvisoryLocker;
  readonly #cleanupProbability: number;
  readonly #q: {
    get: TemplateStringsArray;
    upsert: TemplateStringsArray;
    delete: TemplateStringsArray;
    has: TemplateStringsArray;
    cleanup: TemplateStringsArray;
  };

  constructor(sql: Sql, options: PostgresRateLimitStorageOptions = {}) {
    const p = validateTablePrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
    this.#sql = sql;
    this.#locker = new AdvisoryLocker(sql, `${p}rl`, {
      lockTimeoutMs: options.lockTimeoutMs,
    });
    this.#cleanupProbability = options.cleanupProbability ?? DEFAULT_CLEANUP_PROBABILITY;
    this.#q = {
      get: tpl([
        `SELECT tokens, last_refill, window_ms, max_messages FROM ${p}rate_limits WHERE key = `,
        ` AND expires_at > `,
        ``,
      ]),
      upsert: tpl([
        `INSERT INTO ${p}rate_limits (key, tokens, last_refill, window_ms, max_messages, expires_at) VALUES (`,
        `, `,
        `, `,
        `, `,
        `, `,
        `, `,
        `) ON CONFLICT (key) DO UPDATE SET tokens = EXCLUDED.tokens, last_refill = EXCLUDED.last_refill, window_ms = EXCLUDED.window_ms, max_messages = EXCLUDED.max_messages, expires_at = EXCLUDED.expires_at`,
      ]),
      delete: tpl([`DELETE FROM ${p}rate_limits WHERE key = `, ``]),
      has: tpl([`SELECT 1 FROM ${p}rate_limits WHERE key = `, ` AND expires_at > `, ` LIMIT 1`]),
      cleanup: tpl([`DELETE FROM ${p}rate_limits WHERE expires_at < `, ``]),
    };
  }

  async getState(key: string): Promise<RateLimitState | null> {
    const rows = await this.#sql<Row[]>(this.#q.get, key, Date.now());
    const row = rows[0];
    if (!row) return null;
    return {
      tokens: Number(row.tokens),
      lastRefill: Number(row.last_refill),
      windowMs: Number(row.window_ms),
      maxMessages: Number(row.max_messages),
    };
  }

  async setState(key: string, state: RateLimitState, ttl: number): Promise<void> {
    await this.#sql(
      this.#q.upsert,
      key,
      state.tokens,
      state.lastRefill,
      state.windowMs,
      state.maxMessages,
      Date.now() + ttl,
    );
    // Amortized sweep: expired rows are invisible to reads either way, this
    // just reclaims their space eventually without a background job.
    if (Math.random() < this.#cleanupProbability) {
      await this.#sql(this.#q.cleanup, Date.now());
    }
  }

  async deleteState(key: string): Promise<void> {
    await this.#sql(this.#q.delete, key);
  }

  async hasState(key: string): Promise<boolean> {
    const rows = await this.#sql<Row[]>(this.#q.has, key, Date.now());
    return rows.length > 0;
  }

  transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return this.#locker.withLock(key, cb);
  }

  /** Release the dedicated advisory-lock connection back to the pool. */
  async close(): Promise<void> {
    await this.#locker.close();
  }
}
