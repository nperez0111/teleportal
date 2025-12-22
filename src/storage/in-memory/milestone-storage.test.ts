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
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      };

      const id = await storage.createMilestone(ctx);

      const milestone = await storage.getMilestone("doc-123", id);
      expect(milestone).not.toBeNull();
      expect(milestone!.id).toBe(id);
      expect(milestone!.name).toBe("v1.0.0");
      expect(milestone!.documentId).toBe("doc-123");
      expect(milestone!.createdAt).toBe(1234567890);
      expect(milestone!.loaded).toBe(true);
    });

    it("should create multiple milestones", async () => {
      const id1 = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const id2 = await storage.createMilestone({
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      const milestone1 = await storage.getMilestone("doc-123", id1);
      const milestone2 = await storage.getMilestone("doc-123", id2);

      expect(milestone1).not.toBeNull();
      expect(milestone1!.id).toBe(id1);
      expect(milestone2).not.toBeNull();
      expect(milestone2!.id).toBe(id2);
    });
  });

  describe("getMilestone", () => {
    it("should return null for non-existent milestone", async () => {
      const milestone = await storage.getMilestone("doc-123", "non-existent");
      expect(milestone).toBeNull();
    });

    it("should return the correct milestone by id", async () => {
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const milestone = await storage.getMilestone("doc-123", id);
      expect(milestone).not.toBeNull();
      expect(milestone!.id).toBe(id);
      expect(milestone!.name).toBe("v1.0.0");
    });

    it("should return milestone with loaded snapshot", async () => {
      const snapshot = createTestSnapshot();
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      const milestone = await storage.getMilestone("doc-123", id);
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
      const id1 = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const id2 = await storage.createMilestone({
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      const id3 = await storage.createMilestone({
        name: "v2.0.0",
        documentId: "doc-123",
        createdAt: 1234567892,
        snapshot: createTestSnapshot(),
      });

      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(3);
      expect(milestones.map((m) => m.id).sort()).toEqual(
        [id1, id2, id3].sort(),
      );
    });

    it("should only return milestones for the specified document", async () => {
      const id1 = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const id2 = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-456",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const id3 = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(2);
      expect(milestones.map((m) => m.id).sort()).toEqual(
        [id1, id3].sort(),
      );

      const milestones2 = await storage.getMilestones("doc-456");
      expect(milestones2.length).toBe(1);
      expect(milestones2[0].id).toBe(id2);
    });
  });

  describe("deleteMilestone", () => {
    it("should delete a milestone by id", async () => {
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.deleteMilestone("doc-123", id);

      const milestone = await storage.getMilestone("doc-123", id);
      expect(milestone).toBeNull();
    });

    it("should delete multiple milestones when given an array", async () => {
      const id1 = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const id2 = await storage.createMilestone({
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      const id3 = await storage.createMilestone({
        name: "v2.0.0",
        documentId: "doc-123",
        createdAt: 1234567892,
        snapshot: createTestSnapshot(),
      });

      await storage.deleteMilestone("doc-123", [id1, id3]);

      expect(await storage.getMilestone("doc-123", id1)).toBeNull();
      expect(await storage.getMilestone("doc-123", id2)).not.toBeNull();
      expect(await storage.getMilestone("doc-123", id3)).toBeNull();
    });
  });
});
