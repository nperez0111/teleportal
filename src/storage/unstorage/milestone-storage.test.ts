import { describe, expect, it, beforeEach } from "bun:test";
import { createStorage } from "unstorage";
import { UnstorageMilestoneStorage } from "./milestone-storage";
import type { MilestoneSnapshot } from "teleportal";
import type { StateVector, Update } from "teleportal";

describe("UnstorageMilestoneStorage", () => {
  const createTestSnapshot = (): MilestoneSnapshot => ({
    stateVector: new Uint8Array([1, 2, 3, 4, 5]) as StateVector,
    update: new Uint8Array([10, 20, 30, 40, 50]) as Update,
  });

  let storage: UnstorageMilestoneStorage;
  let unstorage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    // Create a fresh in-memory storage for each test
    unstorage = createStorage();
    storage = new UnstorageMilestoneStorage(unstorage);
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
    });

    it("should create multiple milestones with different ids", async () => {
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

    it("should store both metadata and content separately", async () => {
      const snapshot = createTestSnapshot();
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      // Verify metadata is stored
      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(1);
      expect(milestones[0].id).toBe(id);

      // Verify content can be loaded via getMilestoneSnapshot
      const fetchedSnapshot = await storage.getMilestoneSnapshot(
        "doc-123",
        id,
      );
      expect(fetchedSnapshot.stateVector).toEqual(snapshot.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot.update);
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

    it("should return milestone with lazy-loaded snapshot", async () => {
      const snapshot = createTestSnapshot();
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      const milestone = await storage.getMilestone("doc-123", id);
      expect(milestone).not.toBeNull();
      expect(milestone!.loaded).toBe(false); // Should be lazy loaded
      const fetchedSnapshot = await milestone!.fetchSnapshot();
      expect(fetchedSnapshot.stateVector).toEqual(snapshot.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot.update);
    });

    it("should not return milestone from different document", async () => {
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const milestone = await storage.getMilestone("doc-456", id);
      expect(milestone).toBeNull();
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

    it("should return milestones with lazy-loaded snapshots", async () => {
      const snapshot = createTestSnapshot();
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(1);
      expect(milestones[0].loaded).toBe(false); // Should be lazy loaded
      const fetchedSnapshot = await milestones[0].fetchSnapshot();
      expect(fetchedSnapshot.stateVector).toEqual(snapshot.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot.update);
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
      expect(
        await storage.getMilestone("doc-123", id2),
      ).not.toBeNull();
      expect(await storage.getMilestone("doc-123", id3)).toBeNull();
    });

    it("should delete both metadata and content", async () => {
      const id = await storage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.deleteMilestone("doc-123", id);

      // Verify metadata is deleted
      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(0);

      // Verify content is deleted (should throw when trying to fetch)
      await expect(
        storage.getMilestoneSnapshot("doc-123", id),
      ).rejects.toThrow("failed to hydrate milestone");
    });
  });

  describe("persistence", () => {
    it("should persist data across storage instances", async () => {
      const unstorage = createStorage();

      const storage1 = new UnstorageMilestoneStorage(unstorage);
      const id = await storage1.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // Create a new storage instance with the same unstorage backend
      const storage2 = new UnstorageMilestoneStorage(unstorage);

      // Should be able to retrieve the milestone
      const milestone = await storage2.getMilestone("doc-123", id);
      expect(milestone).not.toBeNull();
      expect(milestone!.id).toBe(id);
      expect(milestone!.name).toBe("v1.0.0");
    });
  });

  describe("custom key prefix", () => {
    it("should use custom key prefix", async () => {
      const unstorage = createStorage();
      const customStorage = new UnstorageMilestoneStorage(unstorage, {
        keyPrefix: "custom",
      });

      await customStorage.createMilestone({
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // Check that keys use the custom prefix
      const keys = await unstorage.getKeys("custom:");
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some((key) => key.includes("custom:milestone:"))).toBe(true);
    });
  });
});
