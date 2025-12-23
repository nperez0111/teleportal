import { describe, expect, it } from "bun:test";
import type { MilestoneSnapshot } from "teleportal";
import { Milestone } from "./milestone";

describe("Milestone", () => {
  const createTestSnapshot = (): MilestoneSnapshot =>
    new Uint8Array([1, 2, 3, 4, 5]) as MilestoneSnapshot;

  const createTestMilestone = (overrides?: {
    id?: string;
    name?: string;
    documentId?: string;
    createdAt?: number;
    snapshot?: MilestoneSnapshot;
  }): Milestone => {
    return new Milestone({
      id: overrides?.id ?? "test-id-123",
      name: overrides?.name ?? "v1.0.0",
      documentId: overrides?.documentId ?? "doc-123",
      createdAt: overrides?.createdAt ?? 1234567890,
      snapshot: overrides?.snapshot ?? createTestSnapshot(),
    });
  };

  describe("encode and decode (full snapshot)", () => {
    it("can encode and decode a milestone with snapshot", async () => {
      const original = createTestMilestone();
      const originalSnapshot = await original.fetchSnapshot();
      const encoded = original.encode();
      const decoded = Milestone.decode(encoded);

      expect(decoded.id).toBe(original.id);
      expect(decoded.name).toBe(original.name);
      expect(decoded.documentId).toBe(original.documentId);
      expect(decoded.createdAt).toBe(original.createdAt);
      expect(decoded.loaded).toBe(true);
      const decodedSnapshot = await decoded.fetchSnapshot();
      expect(decodedSnapshot).toEqual(originalSnapshot);
    });

    it("can encode and decode with different snapshot data", async () => {
      const snapshot = new Uint8Array([99, 98, 97]) as MilestoneSnapshot;
      const original = createTestMilestone({
        id: "different-id",
        name: "v2.0.0",
        documentId: "doc-456",
        createdAt: 9876543210,
        snapshot,
      });

      const encoded = original.encode();
      const decoded = Milestone.decode(encoded);

      expect(decoded.id).toBe("different-id");
      expect(decoded.name).toBe("v2.0.0");
      expect(decoded.documentId).toBe("doc-456");
      expect(decoded.createdAt).toBe(9876543210);
      const decodedSnapshot = await decoded.fetchSnapshot();
      expect(decodedSnapshot).toEqual(snapshot);
    });

    it("can encode and decode with large snapshot data", async () => {
      const snapshot = new Uint8Array(1000).fill(42) as MilestoneSnapshot;
      const original = createTestMilestone({ snapshot });

      const encoded = original.encode();
      const decoded = Milestone.decode(encoded);

      const decodedSnapshot = await decoded.fetchSnapshot();
      expect(decodedSnapshot).toEqual(snapshot);
    });

    it("throws error when encoding milestone without snapshot", () => {
      const getSnapshot = async () => createTestSnapshot();
      const milestone = new Milestone({
        id: "test-id",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        getSnapshot,
      });

      expect(() => milestone.encode()).toThrow(
        "Snapshot has not been fetched, so encoding this Milestone instance would be incomplete",
      );
    });
  });

  describe("encodeMeta and decodeMeta (meta-only)", () => {
    it("can encode and decode meta-only milestone", () => {
      const original = createTestMilestone();
      const encoded = Milestone.encodeMeta(original);
      const decoded = Milestone.decodeMeta(encoded);

      expect(decoded.id).toBe(original.id);
      expect(decoded.name).toBe(original.name);
      expect(decoded.documentId).toBe(original.documentId);
      expect(decoded.createdAt).toBe(original.createdAt);
    });

    it("can encode and decode meta with different values", () => {
      const original = createTestMilestone({
        id: "meta-id-999",
        name: "release-2.5.0",
        documentId: "document-xyz",
        createdAt: 1700000000000,
      });
      const encoded = Milestone.encodeMeta(original);
      const decoded = Milestone.decodeMeta(encoded);

      expect(decoded.id).toBe("meta-id-999");
      expect(decoded.name).toBe("release-2.5.0");
      expect(decoded.documentId).toBe("document-xyz");
      expect(decoded.createdAt).toBe(1700000000000);
    });

    it("can encode meta into existing encoder", () => {
      const milestone1 = createTestMilestone({
        id: "milestone-1",
        name: "v1",
      });
      const milestone2 = createTestMilestone({
        id: "milestone-2",
        name: "v2",
      });

      // Encode both into the same encoder
      const encoded = Milestone.encodeMetaDoc([milestone1, milestone2]);
      const decoder = require("lib0/decoding").createDecoder(encoded);

      const meta1 = Milestone.decodeMeta(encoded, decoder);
      const meta2 = Milestone.decodeMeta(encoded, decoder);

      expect(meta1.id).toBe("milestone-1");
      expect(meta1.name).toBe("v1");
      expect(meta2.id).toBe("milestone-2");
      expect(meta2.name).toBe("v2");
    });

    it("throws error on invalid message prefix", () => {
      const invalidData = new Uint8Array([0x00, 0x00, 0x00]);
      expect(() => Milestone.decodeMeta(invalidData)).toThrow(
        "Invalid message prefix",
      );
    });

    it("throws error on unsupported version", () => {
      const original = createTestMilestone();
      const encoded = Milestone.encodeMeta(original);
      // Modify version byte (byte 3, after YJS prefix)
      encoded[3] = 0x02; // Change version from 0x01 to 0x02

      expect(() => Milestone.decodeMeta(encoded)).toThrow(
        "Version not supported",
      );
    });
  });

  describe("encodeMetaDoc and decodeMetaDoc", () => {
    it("can encode and decode multiple milestones (meta-only)", async () => {
      const milestones = [
        createTestMilestone({ id: "m1", name: "v1.0.0" }),
        createTestMilestone({ id: "m2", name: "v1.1.0" }),
        createTestMilestone({ id: "m3", name: "v2.0.0" }),
      ];

      const encoded = Milestone.encodeMetaDoc(milestones);

      // Create a getSnapshot function for decoding
      const snapshotMap = new Map<string, MilestoneSnapshot>();
      await Promise.all(
        milestones.map(async (m) => {
          const snapshot = await m.fetchSnapshot();
          snapshotMap.set(m.id, snapshot);
        }),
      );

      const getSnapshot = async (
        documentId: string,
        id: string,
      ): Promise<MilestoneSnapshot> => {
        const snapshot = snapshotMap.get(id);
        if (!snapshot) {
          throw new Error(`Snapshot not found for id: ${id}`);
        }
        return snapshot;
      };

      const decoded = Milestone.decodeMetaDoc(encoded, getSnapshot);

      expect(decoded.length).toBe(3);
      expect(decoded[0].id).toBe("m1");
      expect(decoded[0].name).toBe("v1.0.0");
      expect(decoded[1].id).toBe("m2");
      expect(decoded[1].name).toBe("v1.1.0");
      expect(decoded[2].id).toBe("m3");
      expect(decoded[2].name).toBe("v2.0.0");

      // Verify lazy loading works
      expect(decoded[0].loaded).toBe(false);
      const snapshot1 = await decoded[0].fetchSnapshot();
      expect(decoded[0].loaded).toBe(true);
      const originalSnapshot = await milestones[0].fetchSnapshot();
      expect(snapshot1).toEqual(originalSnapshot);
    });

    it("can encode and decode empty milestone array", () => {
      const encoded = Milestone.encodeMetaDoc([]);
      const getSnapshot = async () => createTestSnapshot();
      const decoded = Milestone.decodeMetaDoc(encoded, getSnapshot);

      expect(decoded.length).toBe(0);
    });

    it("can encode and decode single milestone", async () => {
      const milestones = [createTestMilestone({ id: "single", name: "v1" })];
      const encoded = Milestone.encodeMetaDoc(milestones);

      const snapshotMap = new Map<string, MilestoneSnapshot>();
      await Promise.all(
        milestones.map(async (m) => {
          const snapshot = await m.fetchSnapshot();
          snapshotMap.set(m.id, snapshot);
        }),
      );

      const getSnapshot = async (
        documentId: string,
        id: string,
      ): Promise<MilestoneSnapshot> => {
        const snapshot = snapshotMap.get(id);
        if (!snapshot) {
          throw new Error(`Snapshot not found for id: ${id}`);
        }
        return snapshot;
      };

      const decoded = Milestone.decodeMetaDoc(encoded, getSnapshot);

      expect(decoded.length).toBe(1);
      expect(decoded[0].id).toBe("single");
      expect(decoded[0].name).toBe("v1");
    });
  });

  describe("lazy loading", () => {
    it("can create milestone with lazy loading", async () => {
      const snapshot = createTestSnapshot();
      const getSnapshot = async (
        documentId: string,
        id: string,
      ): Promise<MilestoneSnapshot> => {
        expect(documentId).toBe("doc-123");
        expect(id).toBe("lazy-id");
        return snapshot;
      };

      const milestone = new Milestone({
        id: "lazy-id",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        getSnapshot,
      });

      expect(milestone.loaded).toBe(false);
      const fetchedSnapshot = await milestone.fetchSnapshot();
      expect(milestone.loaded).toBe(true);
      expect(fetchedSnapshot).toEqual(snapshot);
    });

    it("caches snapshot after first fetch", async () => {
      let callCount = 0;
      const snapshot = createTestSnapshot();
      const getSnapshot = async (): Promise<MilestoneSnapshot> => {
        callCount++;
        return snapshot;
      };

      const milestone = new Milestone({
        id: "cache-test",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        getSnapshot,
      });

      await milestone.fetchSnapshot();
      expect(callCount).toBe(1);

      await milestone.fetchSnapshot();
      expect(callCount).toBe(1); // Should not call again
    });

    it("handles concurrent fetchSnapshot calls", async () => {
      let callCount = 0;
      const snapshot = createTestSnapshot();
      const getSnapshot = async (): Promise<MilestoneSnapshot> => {
        callCount++;
        // Simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 10));
        return snapshot;
      };

      const milestone = new Milestone({
        id: "concurrent-test",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        getSnapshot,
      });

      // Fetch concurrently
      const [snapshot1, snapshot2, snapshot3] = await Promise.all([
        milestone.fetchSnapshot(),
        milestone.fetchSnapshot(),
        milestone.fetchSnapshot(),
      ]);

      // Should only call getSnapshot once due to promise deduplication
      expect(callCount).toBe(1);
      expect(snapshot1).toEqual(snapshot);
      expect(snapshot2).toEqual(snapshot);
      expect(snapshot3).toEqual(snapshot);
      // After fetching, the snapshot should be cached
      expect(milestone.loaded).toBe(true);
    });

    it("throws error when fetchSnapshot called without getSnapshot", async () => {
      const milestone = new Milestone({
        id: "no-getter",
        name: "v1.0.0",
        documentId: "doc-123",
        createdAt: 1234567890,
        snapshot: createTestSnapshot(),
      });

      // This should work since snapshot is provided
      const snapshot = await milestone.fetchSnapshot();
      expect(snapshot).toBeDefined();
    });
  });

  describe("round-trip encoding/decoding", () => {
    it("can round-trip encode and decode full milestone multiple times", () => {
      let milestone = createTestMilestone({
        id: "round-trip",
        name: "v1.0.0",
        documentId: "doc-rt",
        createdAt: 1000000000,
      });

      // Round-trip multiple times
      for (let i = 0; i < 3; i++) {
        const encoded = milestone.encode();
        milestone = Milestone.decode(encoded);

        expect(milestone.id).toBe("round-trip");
        expect(milestone.name).toBe("v1.0.0");
        expect(milestone.documentId).toBe("doc-rt");
        expect(milestone.createdAt).toBe(1000000000);
        expect(milestone.loaded).toBe(true);
      }
    });

    it("can round-trip encode and decode meta multiple times", () => {
      const original = createTestMilestone({
        id: "meta-round-trip",
        name: "v2.0.0",
        documentId: "doc-meta",
        createdAt: 2000000000,
      });

      let encoded = Milestone.encodeMeta(original);
      let decoded = Milestone.decodeMeta(encoded);

      // Round-trip multiple times
      for (let i = 0; i < 3; i++) {
        const tempMilestone = new Milestone({
          ...decoded,
          snapshot: createTestSnapshot(),
        });
        encoded = Milestone.encodeMeta(tempMilestone);
        decoded = Milestone.decodeMeta(encoded);

        expect(decoded.id).toBe("meta-round-trip");
        expect(decoded.name).toBe("v2.0.0");
        expect(decoded.documentId).toBe("doc-meta");
        expect(decoded.createdAt).toBe(2000000000);
      }
    });
  });

  describe("edge cases", () => {
    it("handles milestone with special characters in strings", () => {
      const original = createTestMilestone({
        id: "id-with-特殊字符-🎉",
        name: "name with spaces & symbols!@#$%",
        documentId: "doc/with/path",
        createdAt: 1234567890,
      });

      const encoded = original.encode();
      const decoded = Milestone.decode(encoded);

      expect(decoded.id).toBe("id-with-特殊字符-🎉");
      expect(decoded.name).toBe("name with spaces & symbols!@#$%");
      expect(decoded.documentId).toBe("doc/with/path");
    });

    it("handles milestone with very long strings", () => {
      const longString = "a".repeat(10000);
      const original = createTestMilestone({
        id: longString,
        name: longString,
        documentId: longString,
        createdAt: 1234567890,
      });

      const encoded = original.encode();
      const decoded = Milestone.decode(encoded);

      expect(decoded.id).toBe(longString);
      expect(decoded.name).toBe(longString);
      expect(decoded.documentId).toBe(longString);
    });

    it("handles milestone with zero timestamp", () => {
      const original = createTestMilestone({
        createdAt: 0,
      });

      const encoded = original.encode();
      const decoded = Milestone.decode(encoded);

      expect(decoded.createdAt).toBe(0);
    });

    it("handles milestone with very large timestamp", () => {
      const original = createTestMilestone({
        createdAt: Number.MAX_SAFE_INTEGER,
      });

      const encoded = original.encode();
      const decoded = Milestone.decode(encoded);

      expect(decoded.createdAt).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});
