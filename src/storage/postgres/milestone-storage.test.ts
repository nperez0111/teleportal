import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { MilestoneSnapshot } from "teleportal";
import { PostgresMilestoneStorage } from "./milestone-storage";
import { dropSchema, ensureSchema } from "./schema";
import { isPostgresAvailable, makeTestSql, randomTablePrefix } from "./test-utils";
import type { Sql } from "./types";

let available = false;
let sql: (Sql & { end(): Promise<void> }) | undefined;
const prefix = randomTablePrefix();
let storage: PostgresMilestoneStorage;

function makeSnapshot(bytes: number[] = [1, 2, 3, 4, 5]): MilestoneSnapshot {
  return new Uint8Array(bytes) as MilestoneSnapshot;
}

function docId(): string {
  return `doc-${crypto.randomUUID()}`;
}

function makeCtx(
  documentId: string,
  overrides: Partial<Parameters<PostgresMilestoneStorage["createMilestone"]>[0]> = {},
) {
  return {
    name: "v1",
    documentId,
    createdAt: 1,
    snapshot: makeSnapshot(),
    createdBy: { type: "system" as const, id: "test-node" },
    ...overrides,
  };
}

beforeAll(async () => {
  available = await isPostgresAvailable();
  if (!available) return;
  sql = makeTestSql(4);
  await ensureSchema(sql, { tablePrefix: prefix });
  storage = new PostgresMilestoneStorage(sql, { tablePrefix: prefix });
});

afterAll(async () => {
  if (sql) {
    await dropSchema(sql, { tablePrefix: prefix });
    await sql.end();
  }
});

describe("PostgresMilestoneStorage", () => {
  it("creates milestones and returns generated ids", async () => {
    if (!available) return;
    const doc = docId();
    const id = await storage.createMilestone(
      makeCtx(doc, { name: "v1.0.0", createdAt: 1_234_567_890 }),
    );

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const milestone = await storage.getMilestone(doc, id);
    expect(milestone).not.toBeNull();
    expect(milestone!.id).toBe(id);
    expect(milestone!.name).toBe("v1.0.0");
    expect(milestone!.documentId).toBe(doc);
    expect(milestone!.createdAt).toBe(1_234_567_890);
    expect(milestone!.createdBy).toEqual({ type: "system", id: "test-node" });
  });

  it("hydrates the snapshot lazily and round-trips its bytes", async () => {
    if (!available) return;
    const doc = docId();
    const snapshot = makeSnapshot([9, 8, 7, 6]);
    const id = await storage.createMilestone(makeCtx(doc, { snapshot }));

    const milestone = await storage.getMilestone(doc, id);
    expect(milestone!.loaded).toBe(false);
    expect(await milestone!.fetchSnapshot()).toEqual(snapshot);
    expect(milestone!.loaded).toBe(true);
  });

  it("rejects hydration when the milestone row is gone", async () => {
    if (!available) return;
    const doc = docId();
    const id = await storage.createMilestone(makeCtx(doc));
    const milestone = await storage.getMilestone(doc, id);

    // Hard delete out from under the lazy Milestone instance.
    await storage.deleteMilestone(doc, id);
    await storage.deleteMilestone(doc, id);

    expect(milestone!.fetchSnapshot()).rejects.toThrow("failed to hydrate milestone");
  });

  it("lists milestones by document ordered by createdAt", async () => {
    if (!available) return;
    const docA = docId();
    const docB = docId();
    const id3 = await storage.createMilestone(makeCtx(docA, { name: "v3", createdAt: 3 }));
    await storage.createMilestone(makeCtx(docB, { name: "v2", createdAt: 2 }));
    const id1 = await storage.createMilestone(makeCtx(docA, { name: "v1", createdAt: 1 }));

    const milestones = await storage.getMilestones(docA);
    expect(milestones.map((m) => m.id)).toEqual([id1, id3]);
    expect(milestones.every((m) => m.documentId === docA)).toBe(true);
  });

  it("filters by lifecycleState and includeDeleted", async () => {
    if (!available) return;
    const doc = docId();
    const active = await storage.createMilestone(makeCtx(doc, { name: "active", createdAt: 1 }));
    const deleted = await storage.createMilestone(makeCtx(doc, { name: "deleted", createdAt: 2 }));
    await storage.deleteMilestone(doc, deleted);

    // Default excludes soft-deleted milestones.
    expect((await storage.getMilestones(doc)).map((m) => m.id)).toEqual([active]);

    const all = await storage.getMilestones(doc, { includeDeleted: true });
    expect(all.map((m) => m.id)).toEqual([active, deleted]);

    const onlyDeleted = await storage.getMilestones(doc, {
      includeDeleted: true,
      lifecycleState: "deleted",
    });
    expect(onlyDeleted.map((m) => m.id)).toEqual([deleted]);
    expect(onlyDeleted[0].lifecycleState).toBe("deleted");
  });

  it("deletes milestones by id or id[]", async () => {
    if (!available) return;
    const doc = docId();
    const id1 = await storage.createMilestone(makeCtx(doc, { name: "v1", createdAt: 1 }));
    const id2 = await storage.createMilestone(makeCtx(doc, { name: "v2", createdAt: 2 }));

    await storage.deleteMilestone(doc, id1, "alice");
    // First delete is soft delete.
    expect(await storage.getMilestone(doc, id1)).toBeNull();
    const deletedMilestones = await storage.getMilestones(doc, { includeDeleted: true });
    const deletedMilestone = deletedMilestones.find((m) => m.id === id1);
    expect(deletedMilestone).toBeDefined();
    expect(deletedMilestone?.lifecycleState).toBe("deleted");
    expect(deletedMilestone?.deletedBy).toBe("alice");
    expect(deletedMilestone?.deletedAt).toBeGreaterThan(0);

    // Second delete is hard delete.
    await storage.deleteMilestone(doc, id1);
    const hardDeletedMilestones = await storage.getMilestones(doc, { includeDeleted: true });
    expect(hardDeletedMilestones.find((m) => m.id === id1)).toBeUndefined();

    expect(await storage.getMilestone(doc, id2)).not.toBeNull();

    await storage.deleteMilestone(doc, [id2]);
    expect(await storage.getMilestone(doc, id2)).toBeNull();
  });

  it("supports soft delete and restore", async () => {
    if (!available) return;
    const doc = docId();
    const id = await storage.createMilestone(makeCtx(doc));

    await storage.deleteMilestone(doc, id);
    expect(await storage.getMilestone(doc, id)).toBeNull();

    await storage.restoreMilestone(doc, id);
    const restored = await storage.getMilestone(doc, id);
    expect(restored).not.toBeNull();
    expect(restored?.lifecycleState).toBe("active");
    expect(restored?.deletedAt).toBeUndefined();
    expect(restored?.deletedBy).toBeUndefined();
  });

  it("updates the milestone name", async () => {
    if (!available) return;
    const doc = docId();
    const id = await storage.createMilestone(makeCtx(doc, { name: "old-name" }));

    await storage.updateMilestoneName(doc, id, "new-name");

    const milestone = await storage.getMilestone(doc, id);
    expect(milestone?.name).toBe("new-name");
    // createdBy is untouched when not provided.
    expect(milestone?.createdBy).toEqual({ type: "system", id: "test-node" });
  });

  it("updates createdBy when provided with the rename", async () => {
    if (!available) return;
    const doc = docId();
    const id = await storage.createMilestone(makeCtx(doc));

    await storage.updateMilestoneName(doc, id, "renamed", { type: "user", id: "alice" });

    const milestone = await storage.getMilestone(doc, id);
    expect(milestone?.name).toBe("renamed");
    expect(milestone?.createdBy).toEqual({ type: "user", id: "alice" });
  });

  it("throws when renaming a missing milestone", async () => {
    if (!available) return;
    const doc = docId();
    expect(storage.updateMilestoneName(doc, "missing-id", "name")).rejects.toThrow(
      "Milestone not found",
    );
  });
});
