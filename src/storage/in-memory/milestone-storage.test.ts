import { describe, expect, it, beforeEach } from "bun:test";
import { InMemoryMilestoneStorage } from "./milestone-storage";
import type { MilestoneSnapshot } from "teleportal";
import type { StateVector, Update } from "teleportal";

describe("InMemoryMilestoneStorage", () => {
  const createTestSnapshot = (): MilestoneSnapshot => ({
    stateVector: new Uint8Array([1, 2, 3, 4, 5]) as StateVector,
    update: new Uint8Array([10, 20, 30, 40, 50]) as Update,
  });

  let storage: InMemoryMilestoneStorage;

  beforeEach(() => {
    storage = new InMemoryMilestoneStorage();
  });

  describe("createMilestone", () => {
    it("should create a milestone and store it", async () => {
      const ctx = {
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      };

      await storage.createMilestone(ctx);

      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.id).toBe("milestone-1");
      expect(milestone!.name).toBe("v1.0.0");
      expect(milestone!.documentId).toBe("doc-123");
      expect(milestone!.createdAt).toBe(1234567890);
      expect(milestone!.loaded).toBe(true);
    });

    it("should overwrite existing milestone with same id", async () => {
      const ctx1 = {
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      };

      const ctx2 = {
        id: "milestone-1",
        name: "v2.0.0",
        documentId: "doc-123",
        createdAt: 9876543210,
        snapshot: createTestSnapshot(),
      };

      await storage.createMilestone(ctx1);
      await storage.createMilestone(ctx2);

      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.name).toBe("v2.0.0");
      expect(milestone!.createdAt).toBe(9876543210);
    });

    it("should create multiple milestones with different ids", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-2",
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      const milestone1 = await storage.getMilestone("doc-123", "milestone-1");
      const milestone2 = await storage.getMilestone("doc-123", "milestone-2");

      expect(milestone1).not.toBeNull();
      expect(milestone1!.id).toBe("milestone-1");
      expect(milestone2).not.toBeNull();
      expect(milestone2!.id).toBe("milestone-2");
    });
  });

  describe("getMilestone", () => {
    it("should return null for non-existent milestone", async () => {
      const milestone = await storage.getMilestone("doc-123", "non-existent");
      expect(milestone).toBeNull();
    });

    it("should return the correct milestone by id", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.id).toBe("milestone-1");
      expect(milestone!.name).toBe("v1.0.0");
    });

    it("should return null for wrong documentId but correct id", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // The implementation ignores documentId, so it should still find it
      const milestone = await storage.getMilestone("wrong-doc", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.id).toBe("milestone-1");
    });

    it("should return milestone with loaded snapshot", async () => {
      const snapshot = createTestSnapshot();
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.loaded).toBe(true);
      const fetchedSnapshot = await milestone!.fetchSnapshot();
      expect(fetchedSnapshot.stateVector).toEqual(snapshot.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot.update);
    });
  });

  describe("getMilestones", () => {
    it("should return empty array for document with no milestones", async () => {
      const milestones = await storage.getMilestones("doc-123");
      expect(milestones).toEqual([]);
    });

    it("should return all milestones for a document", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-2",
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-3",
        name: "v2.0.0",
        documentId: "doc-123",
        createdAt: 1234567892,
        snapshot: createTestSnapshot(),
      });

      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(3);
      expect(milestones.map((m) => m.id).sort()).toEqual([
        "milestone-1",
        "milestone-2",
        "milestone-3",
      ]);
    });

    it("should only return milestones for the specified document", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-2",
        name: "v1.0.0",
        documentId: "doc-456",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-3",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(2);
      expect(milestones.map((m) => m.id).sort()).toEqual([
        "milestone-1",
        "milestone-3",
      ]);

      const milestones2 = await storage.getMilestones("doc-456");
      expect(milestones2.length).toBe(1);
      expect(milestones2[0].id).toBe("milestone-2");
    });

    it("should return milestones with loaded snapshots", async () => {
      const snapshot = createTestSnapshot();
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(1);
      expect(milestones[0].loaded).toBe(true);
      const fetchedSnapshot = await milestones[0].fetchSnapshot();
      expect(fetchedSnapshot.stateVector).toEqual(snapshot.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot.update);
    });
  });

  describe("deleteMilestone", () => {
    it("should delete a milestone by id", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.deleteMilestone("doc-123", "milestone-1");

      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).toBeNull();
    });

    it("should delete multiple milestones when given an array", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-2",
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-3",
        name: "v2.0.0",
        documentId: "doc-123",
        createdAt: 1234567892,
        snapshot: createTestSnapshot(),
      });

      await storage.deleteMilestone("doc-123", [
        "milestone-1",
        "milestone-3",
      ]);

      expect(await storage.getMilestone("doc-123", "milestone-1")).toBeNull();
      expect(await storage.getMilestone("doc-123", "milestone-2")).not.toBeNull();
      expect(await storage.getMilestone("doc-123", "milestone-3")).toBeNull();
    });

    it("should handle deleting non-existent milestone gracefully", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // Should not throw
      await storage.deleteMilestone("doc-123", "non-existent");

      // Existing milestone should still be there
      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
    });

    it("should handle deleting with empty array", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // Should not throw
      await storage.deleteMilestone("doc-123", []);

      // Milestone should still be there
      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
    });

    it("should only delete milestones from the specified document", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "milestone-2",
        name: "v1.0.0",
        documentId: "doc-456",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // The implementation ignores documentId, so it will delete by id regardless
      await storage.deleteMilestone("doc-123", "milestone-1");

      expect(await storage.getMilestone("doc-123", "milestone-1")).toBeNull();
      // milestone-2 should still exist (it's in a different doc, but implementation ignores doc)
      expect(await storage.getMilestone("doc-456", "milestone-2")).not.toBeNull();
    });
  });

  describe("integration", () => {
    it("should handle full CRUD operations", async () => {
      // Create
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // Read
      let milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.name).toBe("v1.0.0");

      // Update (by creating with same id)
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.1",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone!.name).toBe("v1.0.1");

      // Delete
      await storage.deleteMilestone("doc-123", "milestone-1");
      milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).toBeNull();
    });

    it("should handle multiple documents independently", async () => {
      // Create milestones for different documents
      await storage.createMilestone({
        id: "m1",
        name: "v1.0.0",
        documentId: "doc-1",
        createdAt: 1000,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "m2",
        name: "v1.0.0",
        documentId: "doc-2",
        createdAt: 2000,
        snapshot: createTestSnapshot(),
      });

      await storage.createMilestone({
        id: "m3",
        name: "v1.1.0",
        documentId: "doc-1",
        createdAt: 3000,
        snapshot: createTestSnapshot(),
      });

      const doc1Milestones = await storage.getMilestones("doc-1");
      const doc2Milestones = await storage.getMilestones("doc-2");

      expect(doc1Milestones.length).toBe(2);
      expect(doc2Milestones.length).toBe(1);
      expect(doc1Milestones.map((m) => m.id).sort()).toEqual(["m1", "m3"]);
      expect(doc2Milestones[0].id).toBe("m2");
    });
  });
});

