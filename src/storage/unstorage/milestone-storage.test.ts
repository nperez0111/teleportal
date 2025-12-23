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

      // Should overwrite the existing milestone
      const milestone = await storage.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.name).toBe("v2.0.0");
      expect(milestone!.createdAt).toBe(9876543210);

      // Should only have one entry in the metadata (no duplicates)
      const milestones = await storage.getMilestones("doc-123");
      const milestone1Entries = milestones.filter(
        (m) => m.id === "milestone-1",
      );
      expect(milestone1Entries.length).toBe(1);
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

    it("should store both metadata and content separately", async () => {
      const snapshot = createTestSnapshot();
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      // Verify metadata is stored
      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(1);
      expect(milestones[0].id).toBe("milestone-1");

      // Verify content can be loaded via getMilestoneSnapshot
      const fetchedSnapshot = await storage.getMilestoneSnapshot(
        "doc-123",
        "milestone-1",
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

    it("should return milestone with lazy-loaded snapshot", async () => {
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
      expect(milestone!.loaded).toBe(false); // Should be lazy loaded
      const fetchedSnapshot = await milestone!.fetchSnapshot();
      expect(fetchedSnapshot.stateVector).toEqual(snapshot.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot.update);
    });

    it("should not return milestone from different document", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      const milestone = await storage.getMilestone("doc-456", "milestone-1");
      expect(milestone).toBeNull();
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

    it("should return milestones with lazy-loaded snapshots", async () => {
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
      expect(milestones[0].loaded).toBe(false); // Should be lazy loaded
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

      await storage.deleteMilestone("doc-123", ["milestone-1", "milestone-3"]);

      expect(await storage.getMilestone("doc-123", "milestone-1")).toBeNull();
      expect(
        await storage.getMilestone("doc-123", "milestone-2"),
      ).not.toBeNull();
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

    it("should delete both metadata and content", async () => {
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage.deleteMilestone("doc-123", "milestone-1");

      // Verify metadata is deleted
      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(0);

      // Verify content is deleted (should throw when trying to fetch)
      await expect(
        storage.getMilestoneSnapshot("doc-123", "milestone-1"),
      ).rejects.toThrow("failed to hydrate milestone");
    });
  });

  describe("getMilestoneSnapshot", () => {
    it("should fetch snapshot for existing milestone", async () => {
      const snapshot = createTestSnapshot();
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot,
      });

      const fetchedSnapshot = await storage.getMilestoneSnapshot(
        "doc-123",
        "milestone-1",
      );

      expect(fetchedSnapshot.stateVector).toEqual(snapshot.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot.update);
    });

    it("should throw error for non-existent milestone", async () => {
      await expect(
        storage.getMilestoneSnapshot("doc-123", "non-existent"),
      ).rejects.toThrow("failed to hydrate milestone");
    });
  });

  describe("persistence", () => {
    it("should persist data across storage instances", async () => {
      const unstorage = createStorage();

      const storage1 = new UnstorageMilestoneStorage(unstorage);
      await storage1.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // Create a new storage instance with the same unstorage backend
      const storage2 = new UnstorageMilestoneStorage(unstorage);

      // Should be able to retrieve the milestone
      const milestone = await storage2.getMilestone("doc-123", "milestone-1");
      expect(milestone).not.toBeNull();
      expect(milestone!.id).toBe("milestone-1");
      expect(milestone!.name).toBe("v1.0.0");
    });

    it("should persist milestones across storage instances", async () => {
      const unstorage = createStorage();

      const storage1 = new UnstorageMilestoneStorage(unstorage);
      await storage1.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      await storage1.createMilestone({
        id: "milestone-2",
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      // Create a new storage instance
      const storage2 = new UnstorageMilestoneStorage(unstorage);

      const milestones = await storage2.getMilestones("doc-123");
      expect(milestones.length).toBe(2);
      expect(milestones.map((m) => m.id).sort()).toEqual([
        "milestone-1",
        "milestone-2",
      ]);
    });
  });

  describe("custom key prefix", () => {
    it("should use custom key prefix", async () => {
      const unstorage = createStorage();
      const customStorage = new UnstorageMilestoneStorage(unstorage, {
        keyPrefix: "custom",
      });

      await customStorage.createMilestone({
        id: "milestone-1",
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

    it("should isolate data by key prefix", async () => {
      const unstorage = createStorage();

      const storage1 = new UnstorageMilestoneStorage(unstorage, {
        keyPrefix: "prefix1",
      });
      const storage2 = new UnstorageMilestoneStorage(unstorage, {
        keyPrefix: "prefix2",
      });

      await storage1.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // storage2 should not see storage1's data
      const milestones = await storage2.getMilestones("doc-123");
      expect(milestones.length).toBe(0);
    });
  });

  describe("transaction behavior", () => {
    it("should handle sequential operations with transaction locking", async () => {
      // Create multiple milestones sequentially to avoid transaction conflicts
      // The transaction mechanism serializes operations on the same document
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

      // All milestones should be created
      const milestones = await storage.getMilestones("doc-123");
      expect(milestones.length).toBe(3);
      // Verify all three IDs are present
      const ids = milestones.map((m) => m.id).sort();
      expect(ids).toEqual(["milestone-1", "milestone-2", "milestone-3"]);
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

      // Creating with same id should overwrite
      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.1",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: createTestSnapshot(),
      });

      milestone = await storage.getMilestone("doc-123", "milestone-1");
      // Should be overwritten to v1.0.1
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

    it("should maintain snapshot integrity after multiple operations", async () => {
      const snapshot1 = createTestSnapshot();
      const snapshot2: MilestoneSnapshot = {
        stateVector: new Uint8Array([99, 98, 97]) as StateVector,
        update: new Uint8Array([200, 201, 202]) as Update,
      };

      await storage.createMilestone({
        id: "milestone-1",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: snapshot1,
      });

      await storage.createMilestone({
        id: "milestone-2",
        name: "v1.1.0",
        documentId: "doc-123",
        createdAt: 1234567891,
        snapshot: snapshot2,
      });

      // Delete milestone-1
      await storage.deleteMilestone("doc-123", "milestone-1");

      // Verify milestone-2 still has correct snapshot
      const milestone2 = await storage.getMilestone("doc-123", "milestone-2");
      expect(milestone2).not.toBeNull();
      const fetchedSnapshot = await milestone2!.fetchSnapshot();
      expect(fetchedSnapshot.stateVector).toEqual(snapshot2.stateVector);
      expect(fetchedSnapshot.update).toEqual(snapshot2.update);
    });
  });
});
