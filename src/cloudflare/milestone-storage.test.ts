import { beforeEach, describe, expect, it } from "bun:test";
import type { MilestoneSnapshot } from "teleportal";

import { FakeDOStorage } from "./fake-do-storage";
import { DurableObjectMilestoneStorage } from "./milestone-storage";

describe("DurableObjectMilestoneStorage", () => {
  const createTestSnapshot = (): MilestoneSnapshot =>
    new Uint8Array([1, 2, 3, 4, 5]) as MilestoneSnapshot;

  let storage: DurableObjectMilestoneStorage;

  beforeEach(() => {
    storage = new DurableObjectMilestoneStorage(new FakeDOStorage());
  });

  it("creates milestones and returns generated ids", async () => {
    const id = await storage.createMilestone({
      name: "v1.0.0",
      documentId: "doc-123",
      createdAt: 1_234_567_890,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const milestone = await storage.getMilestone("doc-123", id);
    expect(milestone).not.toBeNull();
    expect(milestone!.id).toBe(id);
    expect(milestone!.name).toBe("v1.0.0");
    expect(milestone!.documentId).toBe("doc-123");
  });

  it("lazily loads snapshots", async () => {
    const id = await storage.createMilestone({
      name: "v1.0.0",
      documentId: "doc-123",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });

    const milestone = await storage.getMilestone("doc-123", id);
    expect(await milestone!.fetchSnapshot()).toEqual(createTestSnapshot());
  });

  it("lists milestones by document", async () => {
    const id1 = await storage.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });
    await storage.createMilestone({
      name: "v2",
      documentId: "doc-2",
      createdAt: 2,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });
    const id3 = await storage.createMilestone({
      name: "v3",
      documentId: "doc-1",
      createdAt: 3,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });

    const milestones = await storage.getMilestones("doc-1");
    const ids = milestones.map((m) => m.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id3);
    expect(milestones.every((m) => m.documentId === "doc-1")).toBe(true);
  });

  it("deletes milestones by id or id[]", async () => {
    const id1 = await storage.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });
    const id2 = await storage.createMilestone({
      name: "v2",
      documentId: "doc-1",
      createdAt: 2,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });

    await storage.deleteMilestone("doc-1", id1);
    // First delete is soft delete
    expect(await storage.getMilestone("doc-1", id1)).toBeNull();
    const deletedMilestones = await storage.getMilestones("doc-1", {
      includeDeleted: true,
    });
    const deletedMilestone = deletedMilestones.find((m) => m.id === id1);
    expect(deletedMilestone).toBeDefined();
    expect(deletedMilestone?.lifecycleState).toBe("deleted");

    // Second delete is hard delete
    await storage.deleteMilestone("doc-1", id1);
    const hardDeletedMilestones = await storage.getMilestones("doc-1", {
      includeDeleted: true,
    });
    expect(hardDeletedMilestones.find((m) => m.id === id1)).toBeUndefined();

    expect(await storage.getMilestone("doc-1", id2)).not.toBeNull();

    await storage.deleteMilestone("doc-1", [id2]);
    expect(await storage.getMilestone("doc-1", id2)).toBeNull();
  });

  it("supports soft delete and restore", async () => {
    const id = await storage.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });

    await storage.deleteMilestone("doc-1", id);
    expect(await storage.getMilestone("doc-1", id)).toBeNull();

    await storage.restoreMilestone("doc-1", id);
    const restored = await storage.getMilestone("doc-1", id);
    expect(restored).not.toBeNull();
    expect(restored?.lifecycleState).toBe("active");
  });

  it("updates milestone names", async () => {
    const id = await storage.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });

    await storage.updateMilestoneName("doc-1", id, "v1-renamed");
    const renamed = await storage.getMilestone("doc-1", id);
    expect(renamed?.name).toBe("v1-renamed");
    expect(await renamed!.fetchSnapshot()).toEqual(createTestSnapshot());
  });

  it("scopes getMilestone and snapshots by documentId (no cross-document leakage)", async () => {
    const id = await storage.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "test-node" },
    });

    // The same milestone id must not resolve under a different document.
    expect(await storage.getMilestone("doc-2", id)).toBeNull();
    // And hydrating its snapshot under the wrong document must fail rather than
    // silently return another document's content.
    await expect(storage.getMilestoneSnapshot("doc-2", id)).rejects.toThrow();
    // The correct document still resolves and hydrates.
    expect(await (await storage.getMilestone("doc-1", id))!.fetchSnapshot()).toEqual(
      createTestSnapshot(),
    );
  });

  it("hydrates the correct snapshot when documents share a milestone id space", async () => {
    // Distinct snapshots under two documents; hydration must not cross wires.
    const snap1 = new Uint8Array([1, 1, 1]) as MilestoneSnapshot;
    const snap2 = new Uint8Array([2, 2, 2]) as MilestoneSnapshot;
    const id1 = await storage.createMilestone({
      name: "a",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: snap1,
      createdBy: { type: "system", id: "n" },
    });
    const id2 = await storage.createMilestone({
      name: "b",
      documentId: "doc-2",
      createdAt: 2,
      snapshot: snap2,
      createdBy: { type: "system", id: "n" },
    });

    expect(await storage.getMilestoneSnapshot("doc-1", id1)).toEqual(snap1);
    expect(await storage.getMilestoneSnapshot("doc-2", id2)).toEqual(snap2);
    expect(await (await storage.getMilestones("doc-1"))[0].fetchSnapshot()).toEqual(snap1);
  });

  it("filters milestones by lifecycleState", async () => {
    const active = await storage.createMilestone({
      name: "active",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "n" },
    });
    const gone = await storage.createMilestone({
      name: "gone",
      documentId: "doc-1",
      createdAt: 2,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "n" },
    });
    await storage.deleteMilestone("doc-1", gone); // soft delete

    const deleted = await storage.getMilestones("doc-1", {
      includeDeleted: true,
      lifecycleState: "deleted",
    });
    expect(deleted.map((m) => m.id)).toEqual([gone]);

    // By default (no includeDeleted) the soft-deleted milestone is hidden and
    // only the surviving one is returned.
    const visible = await storage.getMilestones("doc-1");
    expect(visible.map((m) => m.id)).toEqual([active]);

    // Bug 2: a never-deleted milestone has an undefined lifecycleState on the
    // wire, but must still be returned when filtering for "active".
    const onlyActive = await storage.getMilestones("doc-1", {
      lifecycleState: "active",
    });
    expect(onlyActive.map((m) => m.id)).toEqual([active]);
  });

  it("throws when renaming a milestone that does not exist", async () => {
    await expect(storage.updateMilestoneName("doc-1", "nope", "x")).rejects.toThrow(
      "Milestone not found",
    );
  });

  it("hard-deletes the content blob, not just the metadata entry", async () => {
    const fake = new FakeDOStorage();
    const s = new DurableObjectMilestoneStorage(fake);
    const id = await s.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
      createdBy: { type: "system", id: "n" },
    });
    // meta + content = 2 keys.
    expect(fake.size).toBe(2);

    await s.deleteMilestone("doc-1", id); // soft
    expect(fake.size).toBe(2);
    await s.deleteMilestone("doc-1", id); // hard

    // Content blob is gone; only the (now-empty) meta doc remains.
    await expect(s.getMilestoneSnapshot("doc-1", id)).rejects.toThrow();
    expect(fake.size).toBe(1);
  });
});
