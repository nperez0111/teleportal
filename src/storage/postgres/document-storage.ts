import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";

import type { IndexedSidecar } from "../../lib/protocol/encryption/content-cipher";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
} from "../document-storage";
import type { DocumentMetadata, EncodedContentMap } from "../types";
import {
  decodePendingUpdate,
  encodePendingUpdate,
  encodeIndexedSidecars,
  decodeIndexedSidecars,
} from "./codec";
import { AdvisoryLocker } from "./lock";
import { DEFAULT_TABLE_PREFIX, validateTablePrefix } from "./schema";
import { asUint8Array, tpl, type Row, type Sql } from "./types";

export interface PostgresDocumentStorageOptions {
  /** Table prefix, matching the one given to `ensureSchema`. */
  tablePrefix?: string;
  /** Whether documents are content-encrypted. Defaults to true. */
  encrypted?: boolean;
  /** Advisory-lock wait bound for `transaction()`. Defaults to 30s. */
  lockTimeoutMs?: number;
}

/**
 * Merge-on-read document storage backed by Postgres.
 *
 * - `appendUpdate` is a single O(1) INSERT into an append-only pending log
 *   whose composite primary key `(document_id, id)` is its only index.
 * - Binary payloads live in `bytea` columns via the lib0 codec — no
 *   base64/hex inflation.
 * - `transaction()` is per-key mutual exclusion via {@link AdvisoryLocker};
 *   composite writes that must be atomic use local BEGIN/COMMIT instead.
 *
 * Run `ensureSchema(sql, { tablePrefix })` once at startup. The injected
 * client can be `postgres` (porsager) or `Bun.sql`; the adapter never ends
 * the pool. Call {@link close} to release the dedicated lock connection.
 */
export class PostgresDocumentStorage extends AbstractDocumentStorage {
  static ATTRIBUTION_COMPACTION_THRESHOLD = 20;

  readonly #sql: Sql;
  readonly #locker: AdvisoryLocker;
  readonly #q: {
    append: TemplateStringsArray;
    getPending: TemplateStringsArray;
    clearAll: TemplateStringsArray;
    clearUpTo: TemplateStringsArray;
    getBase: TemplateStringsArray;
    replaceBase: TemplateStringsArray;
    getMeta: TemplateStringsArray;
    writeMeta: TemplateStringsArray;
    insertAttr: TemplateStringsArray;
    insertAttrPlain: TemplateStringsArray;
    getAttrs: TemplateStringsArray;
    deleteDoc: TemplateStringsArray;
    deletePending: TemplateStringsArray;
    deleteAttrs: TemplateStringsArray;
    deleteAttrsUpTo: TemplateStringsArray;
  };

  constructor(sql: Sql, options: PostgresDocumentStorageOptions = {}) {
    super(options.encrypted ?? true);
    const p = validateTablePrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
    this.#sql = sql;
    this.#locker = new AdvisoryLocker(sql, `${p}doc`, {
      lockTimeoutMs: options.lockTimeoutMs,
    });
    this.#q = {
      append: tpl([`INSERT INTO ${p}pending_updates (document_id, payload) VALUES (`, `, `, `)`]),
      getPending: tpl([
        `SELECT id, payload FROM ${p}pending_updates WHERE document_id = `,
        ` ORDER BY id`,
      ]),
      clearAll: tpl([`DELETE FROM ${p}pending_updates WHERE document_id = `, ``]),
      clearUpTo: tpl([`DELETE FROM ${p}pending_updates WHERE document_id = `, ` AND id <= `, ``]),
      getBase: tpl([`SELECT update_data, sidecars FROM ${p}documents WHERE document_id = `, ``]),
      replaceBase: tpl([
        `INSERT INTO ${p}documents (document_id, update_data, sidecars) VALUES (`,
        `, `,
        `, `,
        `) ON CONFLICT (document_id) DO UPDATE SET update_data = EXCLUDED.update_data, sidecars = EXCLUDED.sidecars`,
      ]),
      getMeta: tpl([`SELECT metadata FROM ${p}documents WHERE document_id = `, ``]),
      writeMeta: tpl([
        `INSERT INTO ${p}documents (document_id, metadata) VALUES (`,
        `, `,
        `::jsonb) ON CONFLICT (document_id) DO UPDATE SET metadata = EXCLUDED.metadata`,
      ]),
      // The count is taken in the same round trip as the insert. The CTE's
      // row is not visible to the outer SELECT (same snapshot), so the
      // post-insert total is count + 1.
      insertAttr: tpl([
        `WITH ins AS (INSERT INTO ${p}attributions (document_id, content_map) VALUES (`,
        `, `,
        `) RETURNING 1) SELECT count(*)::int AS count FROM ${p}attributions WHERE document_id = `,
        ``,
      ]),
      insertAttrPlain: tpl([
        `INSERT INTO ${p}attributions (document_id, content_map) VALUES (`,
        `, `,
        `)`,
      ]),
      getAttrs: tpl([
        `SELECT id, content_map FROM ${p}attributions WHERE document_id = `,
        ` ORDER BY id`,
      ]),
      deleteDoc: tpl([`DELETE FROM ${p}documents WHERE document_id = `, ``]),
      deletePending: tpl([`DELETE FROM ${p}pending_updates WHERE document_id = `, ``]),
      deleteAttrs: tpl([`DELETE FROM ${p}attributions WHERE document_id = `, ``]),
      deleteAttrsUpTo: tpl([
        `DELETE FROM ${p}attributions WHERE document_id = `,
        ` AND id <= `,
        ``,
      ]),
    };
  }

  // ── Pending log ──────────────────────────────────────────────────────────

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    await this.#sql(this.#q.append, key, encodePendingUpdate(entry));
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    const rows = await this.#sql<Row[]>(this.#q.getPending, key);
    return {
      updates: rows.map((r) => decodePendingUpdate(asUint8Array(r.payload))),
      // Cursor is the max log id, not a count. Callers treat the cursor as
      // opaque (the only value ever passed to clearPendingUpdates is
      // Infinity), and per-key appends are serialized by transaction() in
      // handleUpdate/handleCompaction, so a range delete `id <= cursor`
      // removes exactly the consumed entries.
      cursor: rows.length === 0 ? 0 : Number(rows[rows.length - 1].id),
    };
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    if (upToCursor <= 0) return;
    if (!Number.isFinite(upToCursor)) {
      await this.#sql(this.#q.clearAll, key);
    } else {
      await this.#sql(this.#q.clearUpTo, key, Math.trunc(upToCursor));
    }
  }

  // ── Base state ───────────────────────────────────────────────────────────

  async getBaseState(key: string): Promise<DocumentState | null> {
    const rows = await this.#sql<Row[]>(this.#q.getBase, key);
    const row = rows[0];
    // A row with null update_data exists when only metadata was written.
    if (!row || row.update_data == null) return null;
    return {
      update: asUint8Array(row.update_data),
      sidecars: row.sidecars == null ? [] : decodeIndexedSidecars(asUint8Array(row.sidecars)),
    };
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    await this.#sql(this.#q.replaceBase, key, update, encodeIndexedSidecars(sidecars));
  }

  // ── Metadata ─────────────────────────────────────────────────────────────

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const rows = await this.#sql<Row[]>(this.#q.getMeta, key);
    if (rows.length === 0) {
      return { createdAt: now, updatedAt: now, encrypted: this.encrypted };
    }
    const raw = rows[0].metadata;
    const m = (typeof raw === "string" ? JSON.parse(raw) : raw) as DocumentMetadata;
    return {
      ...m,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now,
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now,
      encrypted: typeof m.encrypted === "boolean" ? m.encrypted : this.encrypted,
    };
  }

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    await this.#sql(this.#q.writeMeta, key, JSON.stringify(metadata));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async deleteDocument(key: string): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx(this.#q.deleteDoc, key);
      await tx(this.#q.deletePending, key);
      await tx(this.#q.deleteAttrs, key);
    });
  }

  override transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return this.#locker.withLock(key, cb);
  }

  /** Release the dedicated advisory-lock connection back to the pool. */
  async close(): Promise<void> {
    await this.#locker.close();
  }

  // ── Attribution ──────────────────────────────────────────────────────────

  override async storeAttribution(key: string, attribution: EncodedContentMap): Promise<void> {
    const rows = await this.#sql<Row[]>(this.#q.insertAttr, key, attribution, key);
    const total = Number(rows[0]?.count ?? 0) + 1;
    if (total >= PostgresDocumentStorage.ATTRIBUTION_COMPACTION_THRESHOLD) {
      await this.#compactAttributions(key);
    }
  }

  async retrieveAttribution(key: string): Promise<EncodedContentMap | null> {
    const rows = await this.#sql<Row[]>(this.#q.getAttrs, key);
    if (rows.length === 0) return null;
    if (rows.length === 1) {
      return asUint8Array(rows[0].content_map) as EncodedContentMap;
    }
    const merged = mergeContentMaps(
      rows.map((r) => decodeContentMap(asUint8Array(r.content_map) as EncodedContentMap)),
    );
    return encodeContentMap(merged);
  }

  /**
   * Replace all attribution rows for a document with one merged blob.
   * Callers of storeAttribution hold the document advisory lock (via
   * handleUpdate's transaction), and the BEGIN/COMMIT keeps the
   * delete + reinsert atomic against crashes.
   */
  async #compactAttributions(key: string): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx<Row[]>(this.#q.getAttrs, key);
      if (rows.length < 2) return;
      const maxId = rows[rows.length - 1].id as number | string | bigint;
      const merged = mergeContentMaps(
        rows.map((r) => decodeContentMap(asUint8Array(r.content_map) as EncodedContentMap)),
      );
      await tx(this.#q.deleteAttrsUpTo, key, maxId);
      await tx(this.#q.insertAttrPlain, key, encodeContentMap(merged));
    });
  }
}
