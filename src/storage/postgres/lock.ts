import type { ReservedSql, Sql } from "./types";

/**
 * Thrown when advisory-lock acquisition exceeds the configured `lockTimeoutMs`
 * — typically a sign of a wedged lock holder.
 */
export class LockTimeoutError extends Error {
  constructor(key: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for advisory lock on "${key}"`);
    this.name = "LockTimeoutError";
  }
}

export interface AdvisoryLockerOptions {
  /**
   * How long a lock acquisition may wait before failing with
   * {@link LockTimeoutError}. Defaults to 30s.
   */
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/**
 * Backoff between non-blocking `pg_try_advisory_lock` polls. Small enough to
 * feel responsive under contention, large enough not to spin the connection.
 * Capped so it never overshoots a short `lockTimeoutMs`.
 */
const POLL_BASE_MS = 5;
const POLL_MAX_MS = 50;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `statement_timeout` cancellations surface as SQLSTATE 57014. */
function isStatementTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; errno?: unknown; message?: unknown };
  return (
    e?.code === "57014" ||
    e?.errno === "57014" ||
    (typeof e?.message === "string" && e.message.includes("statement timeout"))
  );
}

/**
 * Per-key mutual exclusion backed by Postgres session advisory locks.
 *
 * Two layers:
 * - In-process: a promise chain per key serializes local callers. This is
 *   required for correctness, not just efficiency — session advisory locks
 *   are re-entrant within one session, so the shared lock connection alone
 *   cannot exclude two local callers.
 * - Cross-process: `pg_try_advisory_lock(hashtextextended(ns:key, 0))` held on
 *   a single dedicated connection reserved from the injected pool, created
 *   lazily and kept for the locker's lifetime. One connection per locker (not
 *   per acquisition) so concurrent transactions can never reserve the whole
 *   pool and starve their own callbacks.
 *
 *   Acquisition polls the *non-blocking* `pg_try_advisory_lock` with a short
 *   backoff rather than the blocking `pg_advisory_lock`. This is essential
 *   given the shared connection: different keys have independent in-process
 *   chains, so two keys can be mid-acquisition at once. A blocking lock would
 *   park the single connection server-side, wedging every other key's
 *   unlock/acquire behind it (cross-key head-of-line blocking and spurious
 *   timeouts). A try-lock returns immediately, so unlocks and other keys'
 *   acquisitions always interleave. The total wait is bounded by
 *   `lockTimeoutMs`, after which acquisition throws {@link LockTimeoutError}.
 *
 * Locks release instantly when the session dies (process crash included) —
 * no TTL expiry window, no lock stealing. Not re-entrant: a `withLock` call
 * nested inside another `withLock` for the same key deadlocks (the in-process
 * chain never advances), matching the constraint of the unstorage TTL lock.
 */
export class AdvisoryLocker {
  readonly #sql: Sql;
  readonly #namespace: string;
  readonly #lockTimeoutMs: number;
  #conn: ReservedSql | undefined;
  #connPromise: Promise<ReservedSql> | undefined;
  #chains = new Map<string, Promise<void>>();
  #closed = false;

  constructor(sql: Sql, namespace: string, options: AdvisoryLockerOptions = {}) {
    this.#sql = sql;
    this.#namespace = namespace;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async withLock<T>(key: string, cb: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new Error("AdvisoryLocker is closed");
    }
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.#locked(key, cb));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(key, tail);
    void tail.then(() => {
      if (this.#chains.get(key) === tail) {
        this.#chains.delete(key);
      }
    });
    return run;
  }

  /**
   * Release the dedicated lock connection back to the pool. Callers own the
   * pool itself (`sql.end()` is theirs). Safe to call multiple times.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const conn = this.#conn ?? (await this.#connPromise?.catch(() => undefined));
    this.#conn = undefined;
    this.#connPromise = undefined;
    if (conn) {
      // The connection returns to the pool, so restore the default
      // statement_timeout instead of leaking ours onto unrelated queries.
      try {
        await conn`SELECT set_config('statement_timeout', '0', false)`;
      } catch {
        // Connection already dead — nothing to restore.
      }
      conn.release();
    }
  }

  async #locked<T>(key: string, cb: () => Promise<T>): Promise<T> {
    const lockKey = `${this.#namespace}:${key}`;
    const conn = await this.#getConn();
    await this.#acquire(conn, lockKey);
    try {
      return await cb();
    } finally {
      try {
        await conn`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
      } catch {
        // Unlock only fails when the session is gone, which released the
        // lock anyway. Reconnect lazily on the next acquisition.
        this.#reset(conn);
      }
    }
  }

  /**
   * Poll `pg_try_advisory_lock` (non-blocking) until it grants the lock or the
   * `lockTimeoutMs` deadline passes. Never parks the shared connection
   * server-side, so unlocks and other keys' acquisitions keep interleaving.
   */
  async #acquire(conn: ReservedSql, lockKey: string): Promise<void> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    let backoff = POLL_BASE_MS;
    for (;;) {
      let locked: boolean;
      try {
        const rows =
          (await conn`SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS locked`) as {
            locked: boolean;
          }[];
        locked = rows[0]?.locked === true;
      } catch (error) {
        if (isStatementTimeout(error)) {
          throw new LockTimeoutError(lockKey, this.#lockTimeoutMs);
        }
        // Anything else means the lock connection is suspect (e.g. it died and
        // took its locks with it). Drop it so the next call reconnects.
        this.#reset(conn);
        throw error;
      }
      if (locked) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LockTimeoutError(lockKey, this.#lockTimeoutMs);
      }
      await sleep(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, POLL_MAX_MS);
    }
  }

  #getConn(): Promise<ReservedSql> {
    if (this.#conn) return Promise.resolve(this.#conn);
    this.#connPromise ??= (async () => {
      try {
        const conn = await this.#sql.reserve();
        // Safety net for a wedged connection (e.g. a network stall on an
        // otherwise non-blocking try-lock/unlock). Acquisition waiting is
        // bounded by the poll deadline, not this; only lock/unlock statements
        // run on this dedicated session, so it never truncates real work.
        await conn`SELECT set_config('statement_timeout', ${String(this.#lockTimeoutMs)}, false)`;
        this.#conn = conn;
        return conn;
      } finally {
        this.#connPromise = undefined;
      }
    })();
    return this.#connPromise;
  }

  #reset(conn: ReservedSql): void {
    if (this.#conn === conn) {
      this.#conn = undefined;
      try {
        conn.release();
      } catch {
        // Already released/destroyed.
      }
    }
  }
}
