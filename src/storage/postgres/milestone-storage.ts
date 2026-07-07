import { uuidv4 } from "lib0/random";
import { Milestone, type MilestoneSnapshot } from "teleportal";

import type { Document, MilestoneStorage } from "../types";
import { DEFAULT_TABLE_PREFIX, validateTablePrefix } from "./schema";
import { asUint8Array, tpl, type Row, type Sql } from "./types";

export interface PostgresMilestoneStorageOptions {
  /** Table prefix, matching the one given to `ensureSchema`. */
  tablePrefix?: string;
}

/**
 * Milestone storage backed by Postgres.
 *
 * - Metadata and snapshot share one row in `milestones`, but list reads never
 *   touch the `snapshot` bytea column: {@link getMilestones} returns lazy
 *   {@link Milestone} instances whose `fetchSnapshot()` issues a targeted
 *   single-row read. Snapshots are stored as raw bytes (the meta already
 *   lives in columns, so the unstorage adapter's meta+snapshot framing would
 *   be redundant).
 * - Deletion follows the unstorage adapter's two-phase semantics: the first
 *   delete is a soft delete (lifecycle marker), a second delete of an
 *   already-deleted milestone removes the row for good.
 * - Every method is a single statement or one small BEGIN/COMMIT; no advisory
 *   locks are needed.
 *
 * Run `ensureSchema(sql, { tablePrefix })` once at startup. The injected
 * client can be `postgres` (porsager) or `Bun.sql`; the adapter never ends
 * the pool.
 */
export class PostgresMilestoneStorage implements MilestoneStorage {
  readonly type = "milestone-storage" as const;

  readonly #sql: Sql;
  readonly #q: {
    insert: TemplateStringsArray;
    list: TemplateStringsArray;
    getOne: TemplateStringsArray;
    getSnapshot: TemplateStringsArray;
    hardDelete: TemplateStringsArray;
    softDelete: TemplateStringsArray;
    restore: TemplateStringsArray;
    rename: TemplateStringsArray;
    renameWithCreatedBy: TemplateStringsArray;
  };

  constructor(sql: Sql, options: PostgresMilestoneStorageOptions = {}) {
    const p = validateTablePrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
    this.#sql = sql;
    // All list/get templates select every column except the snapshot bytea,
    // keeping metadata reads cheap regardless of snapshot size.
    const metaColumns =
      "id, name, created_at, created_by_type, created_by_id, lifecycle_state, deleted_at, deleted_by, retention_policy_id, expires_at";
    this.#q = {
      // ON CONFLICT is defensive against a uuid collision: mirror the
      // unstorage adapter, which replaces the milestone wholesale (including
      // clearing any deletion markers).
      insert: tpl([
        `INSERT INTO ${p}milestones (document_id, id, name, created_at, created_by_type, created_by_id, lifecycle_state, snapshot) VALUES (`,
        `, `,
        `, `,
        `, `,
        `, `,
        `, `,
        `, 'active', `,
        `) ON CONFLICT (document_id, id) DO UPDATE SET name = EXCLUDED.name, created_at = EXCLUDED.created_at, created_by_type = EXCLUDED.created_by_type, created_by_id = EXCLUDED.created_by_id, lifecycle_state = EXCLUDED.lifecycle_state, deleted_at = NULL, deleted_by = NULL, snapshot = EXCLUDED.snapshot`,
      ]),
      list: tpl([
        `SELECT ${metaColumns} FROM ${p}milestones WHERE document_id = `,
        ` ORDER BY created_at`,
      ]),
      getOne: tpl([
        `SELECT ${metaColumns} FROM ${p}milestones WHERE document_id = `,
        ` AND id = `,
        ` AND lifecycle_state <> 'deleted'`,
      ]),
      getSnapshot: tpl([
        `SELECT snapshot FROM ${p}milestones WHERE document_id = `,
        ` AND id = `,
        ``,
      ]),
      hardDelete: tpl([
        `DELETE FROM ${p}milestones WHERE document_id = `,
        ` AND id = ANY(`,
        `) AND lifecycle_state = 'deleted'`,
      ]),
      softDelete: tpl([
        `UPDATE ${p}milestones SET lifecycle_state = 'deleted', deleted_at = `,
        `, deleted_by = `,
        ` WHERE document_id = `,
        ` AND id = ANY(`,
        `)`,
      ]),
      restore: tpl([
        `UPDATE ${p}milestones SET lifecycle_state = 'active', deleted_at = NULL, deleted_by = NULL WHERE document_id = `,
        ` AND id = ANY(`,
        `) AND lifecycle_state = 'deleted'`,
      ]),
      rename: tpl([
        `UPDATE ${p}milestones SET name = `,
        ` WHERE document_id = `,
        ` AND id = `,
        ` RETURNING id`,
      ]),
      renameWithCreatedBy: tpl([
        `UPDATE ${p}milestones SET name = `,
        `, created_by_type = `,
        `, created_by_id = `,
        ` WHERE document_id = `,
        ` AND id = `,
        ` RETURNING id`,
      ]),
    };
  }

  async createMilestone(ctx: {
    name: string;
    documentId: Document["id"];
    createdAt: number;
    snapshot: MilestoneSnapshot;
    createdBy: { type: "user" | "system"; id: string };
  }): Promise<string> {
    const id = uuidv4();
    await this.#sql(
      this.#q.insert,
      ctx.documentId,
      id,
      ctx.name,
      ctx.createdAt,
      ctx.createdBy.type,
      ctx.createdBy.id,
      ctx.snapshot,
    );
    return id;
  }

  async getMilestone(documentId: Document["id"], id: Milestone["id"]): Promise<Milestone | null> {
    const rows = await this.#sql<Row[]>(this.#q.getOne, documentId, id);
    const row = rows[0];
    return row ? this.#rowToMilestone(documentId, row) : null;
  }

  async getMilestones(
    documentId: Document["id"],
    options?: {
      includeDeleted?: boolean;
      lifecycleState?: Milestone["lifecycleState"];
    },
  ): Promise<Milestone[]> {
    const rows = await this.#sql<Row[]>(this.#q.list, documentId);
    let milestones = rows.map((row) => this.#rowToMilestone(documentId, row));

    if (!options?.includeDeleted) {
      milestones = milestones.filter((m) => m.lifecycleState !== "deleted");
    }

    if (options?.lifecycleState) {
      milestones = milestones.filter((m) => m.lifecycleState === options.lifecycleState);
    }

    return milestones;
  }

  async deleteMilestone(
    documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
    deletedBy?: string,
  ): Promise<void> {
    const ids = Array.isArray(id) ? id : [id];
    await this.#sql.begin(async (tx) => {
      // Already soft-deleted rows are removed for good; the remaining rows
      // (untouched by the DELETE) are then soft-deleted.
      await tx(this.#q.hardDelete, documentId, ids);
      await tx(this.#q.softDelete, Date.now(), deletedBy ?? null, documentId, ids);
    });
  }

  async restoreMilestone(
    documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
  ): Promise<void> {
    const ids = Array.isArray(id) ? id : [id];
    await this.#sql(this.#q.restore, documentId, ids);
  }

  async updateMilestoneName(
    documentId: Document["id"],
    id: Milestone["id"],
    name: string,
    createdBy?: { type: "user" | "system"; id: string },
  ): Promise<void> {
    const rows = createdBy
      ? await this.#sql<Row[]>(
          this.#q.renameWithCreatedBy,
          name,
          createdBy.type,
          createdBy.id,
          documentId,
          id,
        )
      : await this.#sql<Row[]>(this.#q.rename, name, documentId, id);
    if (rows.length === 0) {
      throw new Error("Milestone not found", { cause: { documentId, id } });
    }
  }

  /** Lazy snapshot hydrator passed to every {@link Milestone} instance. */
  #getSnapshot = async (documentId: string, id: string): Promise<MilestoneSnapshot> => {
    const rows = await this.#sql<Row[]>(this.#q.getSnapshot, documentId, id);
    const row = rows[0];
    if (!row) {
      throw new Error("failed to hydrate milestone", {
        cause: {
          documentId,
          id,
        },
      });
    }
    return asUint8Array(row.snapshot) as MilestoneSnapshot;
  };

  #rowToMilestone(documentId: string, row: Row): Milestone {
    return new Milestone({
      id: String(row.id),
      name: String(row.name),
      documentId,
      createdAt: Number(row.created_at),
      deletedAt: row.deleted_at == null ? undefined : Number(row.deleted_at),
      deletedBy: row.deleted_by == null ? undefined : String(row.deleted_by),
      lifecycleState: row.lifecycle_state as Milestone["lifecycleState"],
      retentionPolicyId:
        row.retention_policy_id == null ? undefined : String(row.retention_policy_id),
      expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
      createdBy: {
        type: row.created_by_type as "user" | "system",
        id: String(row.created_by_id),
      },
      getSnapshot: this.#getSnapshot,
    });
  }
}
