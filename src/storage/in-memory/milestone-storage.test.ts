import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryMilestoneStorage } from "./milestone-storage";
import type { MilestoneSnapshot } from "teleportal";

describe("InMemoryMilestoneStorage", () => {
  const createTestSnapshot = (): MilestoneSnapshot =>
    new Uint8Array([1, 2, 3, 4, 5]) as MilestoneSnapshot;

  let storage: InMemoryMilestoneStorage;

  beforeEach(() => {
    storage = new InMemoryMilestoneStorage();
  });

  it("creates milestones and returns generated ids", async () => {
    const id = await storage.createMilestone({
      name: "v1.0.0",
      documentId: "doc-123",
      createdAt: 1234567890,
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

  describe("documentId scoping (Bug 1)", () => {
    const createInDocA = () =>
      storage.createMilestone({
        name: "v1",
        documentId: "docA",
        createdAt: 1,
        snapshot: createTestSnapshot(),
        createdBy: { type: "system", id: "test-node" },
      });

    it("getMilestone with the wrong documentId returns null", async () => {
      const id = await createInDocA();
      expect(await storage.getMilestone("docB", id)).toBeNull();
      // sanity: still reachable under the correct documentId
      expect(await storage.getMilestone("docA", id)).not.toBeNull();
    });

    it("deleteMilestone with the wrong documentId does not mutate the docA milestone", async () => {
      const id = await createInDocA();
      await storage.deleteMilestone("docB", id);
      const milestone = await storage.getMilestone("docA", id);
      expect(milestone).not.toBeNull();
      expect(milestone?.lifecycleState).not.toBe("deleted");
    });

    it("restoreMilestone with the wrong documentId does not mutate the docA milestone", async () => {
      const id = await createInDocA();
      // soft delete under the correct documentId first
      await storage.deleteMilestone("docA", id);
      // restore under the wrong documentId must be a no-op
      await storage.restoreMilestone("docB", id);
      // still deleted (getMilestone returns null for deleted)
      expect(await storage.getMilestone("docA", id)).toBeNull();
      const [deleted] = await storage.getMilestones("docA", { includeDeleted: true });
      expect(deleted?.lifecycleState).toBe("deleted");
    });

    it("updateMilestoneName with the wrong documentId throws and does not mutate", async () => {
      const id = await createInDocA();
      await expect(storage.updateMilestoneName("docB", id, "renamed")).rejects.toThrow(
        "Milestone not found",
      );
      const milestone = await storage.getMilestone("docA", id);
      expect(milestone?.name).toBe("v1");
    });

    it("updateMilestoneRetention with the wrong documentId throws and does not mutate", async () => {
      const id = await createInDocA();
      await expect(
        storage.updateMilestoneRetention("docB", id, { lifecycleState: "archived" }),
      ).rejects.toThrow("Milestone not found");
      const milestone = await storage.getMilestone("docA", id);
      expect(milestone?.lifecycleState).not.toBe("archived");
    });
  });

  describe("default lifecycleState filtering (Bug 2)", () => {
    it("getMilestones with lifecycleState 'active' includes never-deleted milestones", async () => {
      const id = await storage.createMilestone({
        name: "v1",
        documentId: "doc-1",
        createdAt: 1,
        snapshot: createTestSnapshot(),
        createdBy: { type: "system", id: "test-node" },
      });

      const active = await storage.getMilestones("doc-1", { lifecycleState: "active" });
      expect(active.map((m) => m.id)).toContain(id);
    });
  });
});
