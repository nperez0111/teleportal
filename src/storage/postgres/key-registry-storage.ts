import type {
  KeyRegistryMeta,
  KeyRegistryRecord,
  KeyRegistryStorage,
  WrappedKeyEntry,
} from "../../protocols/key-registry/storage";
import { AdvisoryLocker } from "./lock";
import { DEFAULT_TABLE_PREFIX, validateTablePrefix } from "./schema";
import { asUint8Array, tpl, type Row, type Sql } from "./types";

export interface PostgresKeyRegistryStorageOptions {
  /** Table prefix, matching the one given to `ensureSchema`. */
  tablePrefix?: string;
  /** Advisory-lock wait bound for `transaction()`. Defaults to 30s. */
  lockTimeoutMs?: number;
}

/**
 * Thrown by {@link PostgresKeyRegistryStorage.rotate} when
 * `expectedGeneration` doesn't match the stored generation. The message is
 * byte-identical to `InMemoryKeyRegistryStorage`'s conflict error so callers
 * matching on it behave the same across adapters.
 */
export class KeyRotationConflictError extends Error {
  constructor(expectedGeneration: number, current: number) {
    super(
      `Key rotation conflict: expected generation ${expectedGeneration}, ` +
        `but current is ${current}`,
    );
    this.name = "KeyRotationConflictError";
  }
}

/**
 * Per-document, per-user wrapped encryption keys backed by Postgres.
 *
 * - Keys live in `key_registry` (bytea blobs, composite PK); the per-document
 *   generation counter lives in `key_registry_meta`. `set`/`revoke` never
 *   bump the generation — only {@link rotate} does, guarded by optimistic
 *   concurrency ({@link KeyRotationConflictError} on mismatch).
 * - `rotate` runs inside both the document advisory lock (cross-process
 *   serialization) and BEGIN/COMMIT (crash atomicity), so a failed rotation
 *   leaves the previous keys untouched.
 *
 * Run `ensureSchema(sql, { tablePrefix })` once at startup. The injected
 * client can be `postgres` (porsager) or `Bun.sql`; the adapter never ends
 * the pool. Call {@link close} to release the dedicated lock connection.
 */
export class PostgresKeyRegistryStorage implements KeyRegistryStorage {
  readonly type = "key-registry-storage" as const;

  readonly #sql: Sql;
  readonly #locker: AdvisoryLocker;
  readonly #q: {
    get: TemplateStringsArray;
    getAny: TemplateStringsArray;
    upsertKey: TemplateStringsArray;
    ensureMeta: TemplateStringsArray;
    getGeneration: TemplateStringsArray;
    revoke: TemplateStringsArray;
    getUserIds: TemplateStringsArray;
    deleteKeys: TemplateStringsArray;
    upsertMeta: TemplateStringsArray;
  };

  constructor(sql: Sql, options: PostgresKeyRegistryStorageOptions = {}) {
    const p = validateTablePrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
    this.#sql = sql;
    this.#locker = new AdvisoryLocker(sql, `${p}keys`, {
      lockTimeoutMs: options.lockTimeoutMs,
    });
    this.#q = {
      get: tpl([
        `SELECT k.wrapped_key, coalesce(m.generation, 0) AS generation FROM ${p}key_registry k LEFT JOIN ${p}key_registry_meta m ON m.document_id = k.document_id WHERE k.document_id = `,
        ` AND k.user_id = `,
        ``,
      ]),
      getAny: tpl([
        `SELECT k.user_id, k.wrapped_key, coalesce(m.generation, 0) AS generation FROM ${p}key_registry k LEFT JOIN ${p}key_registry_meta m ON m.document_id = k.document_id WHERE k.document_id = `,
        ` LIMIT 1`,
      ]),
      upsertKey: tpl([
        `INSERT INTO ${p}key_registry (document_id, user_id, wrapped_key) VALUES (`,
        `, `,
        `, `,
        `) ON CONFLICT (document_id, user_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key`,
      ]),
      ensureMeta: tpl([
        `INSERT INTO ${p}key_registry_meta (document_id) VALUES (`,
        `) ON CONFLICT (document_id) DO NOTHING`,
      ]),
      getGeneration: tpl([`SELECT generation FROM ${p}key_registry_meta WHERE document_id = `, ``]),
      revoke: tpl([
        `DELETE FROM ${p}key_registry WHERE document_id = `,
        ` AND user_id = ANY(`,
        `)`,
      ]),
      getUserIds: tpl([
        `SELECT user_id FROM ${p}key_registry WHERE document_id = `,
        ` ORDER BY user_id`,
      ]),
      deleteKeys: tpl([`DELETE FROM ${p}key_registry WHERE document_id = `, ``]),
      upsertMeta: tpl([
        `INSERT INTO ${p}key_registry_meta (document_id, generation) VALUES (`,
        `, `,
        `) ON CONFLICT (document_id) DO UPDATE SET generation = EXCLUDED.generation`,
      ]),
    };
  }

  async get(documentId: string, userId: string): Promise<KeyRegistryRecord | null> {
    const rows = await this.#sql<Row[]>(this.#q.get, documentId, userId);
    const row = rows[0];
    if (!row) return null;
    return {
      wrappedKey: asUint8Array(row.wrapped_key),
      generation: Number(row.generation),
    };
  }

  async getAny(documentId: string): Promise<(KeyRegistryRecord & { userId: string }) | null> {
    const rows = await this.#sql<Row[]>(this.#q.getAny, documentId);
    const row = rows[0];
    if (!row) return null;
    return {
      userId: String(row.user_id),
      wrappedKey: asUint8Array(row.wrapped_key),
      generation: Number(row.generation),
    };
  }

  async set(documentId: string, entries: WrappedKeyEntry[]): Promise<number> {
    return this.#sql.begin(async (tx) => {
      for (const { userId, wrappedKey } of entries) {
        await tx(this.#q.upsertKey, documentId, userId, wrappedKey);
      }
      // Matches the in-memory adapter: set materializes the document's meta
      // (at generation 0) but never bumps an existing generation.
      await tx(this.#q.ensureMeta, documentId);
      const rows = await tx<Row[]>(this.#q.getGeneration, documentId);
      return Number(rows[0]!.generation);
    });
  }

  async revoke(documentId: string, userIds: string[]): Promise<number> {
    await this.#sql(this.#q.revoke, documentId, userIds);
    return this.#currentGeneration(documentId);
  }

  async getMeta(documentId: string): Promise<KeyRegistryMeta> {
    const [generation, rows] = await Promise.all([
      this.#currentGeneration(documentId),
      this.#sql<Row[]>(this.#q.getUserIds, documentId),
    ]);
    return {
      generation,
      userIds: rows.map((r) => String(r.user_id)),
    };
  }

  async rotate(
    documentId: string,
    entries: WrappedKeyEntry[],
    expectedGeneration: number,
  ): Promise<number> {
    // The advisory lock serializes rotations across processes; BEGIN/COMMIT
    // makes the check + replace + bump atomic against crashes, so a failed
    // rotation rolls back to the previous key set.
    return this.transaction(documentId, async () =>
      this.#sql.begin(async (tx) => {
        const rows = await tx<Row[]>(this.#q.getGeneration, documentId);
        const current = rows.length === 0 ? 0 : Number(rows[0].generation);
        if (current !== expectedGeneration) {
          throw new KeyRotationConflictError(expectedGeneration, current);
        }
        await tx(this.#q.deleteKeys, documentId);
        for (const { userId, wrappedKey } of entries) {
          await tx(this.#q.upsertKey, documentId, userId, wrappedKey);
        }
        const next = expectedGeneration + 1;
        await tx(this.#q.upsertMeta, documentId, next);
        return next;
      }),
    );
  }

  transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return this.#locker.withLock(documentId, cb);
  }

  /** Release the dedicated advisory-lock connection back to the pool. */
  async close(): Promise<void> {
    await this.#locker.close();
  }

  /** The stored generation for a document, 0 when no meta row exists. */
  async #currentGeneration(documentId: string): Promise<number> {
    const rows = await this.#sql<Row[]>(this.#q.getGeneration, documentId);
    return rows.length === 0 ? 0 : Number(rows[0].generation);
  }
}
