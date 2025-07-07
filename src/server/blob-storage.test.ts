import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryBlobStorage, BlobStorageManager } from "./blob-storage";
import { logger } from "./logger";
import type {
  DecodedBlobPartMessage,
  DecodedRequestBlobMessage,
} from "../protocol/types";

describe("BlobStorage", () => {
  let storage: InMemoryBlobStorage;
  let manager: BlobStorageManager;

  beforeEach(() => {
    storage = new InMemoryBlobStorage({
      logger,
      maxIncompleteBlobAge: 1000, // 1 second for testing
      maxIncompleteBlobs: 10,
    });
    manager = new BlobStorageManager({
      storage,
      logger,
    });
  });

  describe("InMemoryBlobStorage", () => {
    it("should store and retrieve blob parts", async () => {
      const contentId = "test-content-id";
      const blobPart1: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 2,
        contentId,
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };
      const blobPart2: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 1,
        totalSegments: 2,
        contentId,
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([4, 5, 6]),
      };

      await storage.storeBlobPart(blobPart1);
      await storage.storeBlobPart(blobPart2);

      const parts = await storage.getBlobParts(contentId);
      expect(parts).not.toBeNull();
      expect(parts).toHaveLength(2);
      expect(parts![0]).toEqual(blobPart1);
      expect(parts![1]).toEqual(blobPart2);
    });

    it("should return null for incomplete blobs", async () => {
      const contentId = "test-content-id";
      const blobPart: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 2,
        contentId,
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };

      await storage.storeBlobPart(blobPart);

      const parts = await storage.getBlobParts(contentId);
      expect(parts).toBeNull(); // Not complete yet
    });

    it("should check if blob is complete", async () => {
      const contentId = "test-content-id";
      const blobPart1: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 2,
        contentId,
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };
      const blobPart2: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 1,
        totalSegments: 2,
        contentId,
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([4, 5, 6]),
      };

      await storage.storeBlobPart(blobPart1);
      expect(await storage.isBlobComplete(contentId)).toBe(false);

      await storage.storeBlobPart(blobPart2);
      expect(await storage.isBlobComplete(contentId)).toBe(true);
    });

    it("should remove blob completely", async () => {
      const contentId = "test-content-id";
      const blobPart: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 1,
        contentId,
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };

      await storage.storeBlobPart(blobPart);
      await storage.removeBlob(contentId);

      expect(await storage.getBlobParts(contentId)).toBeNull();
      expect(await storage.isBlobComplete(contentId)).toBe(false);
    });
  });

  describe("BlobStorageManager", () => {
    it("should handle blob part messages", async () => {
      const blobPartMessage: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 2,
        contentId: "test-content-id",
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };

      await manager.handleBlobPart(blobPartMessage);

      // Should not be complete yet
      expect(await storage.isBlobComplete("test-content-id")).toBe(false);
    });

    it("should handle complete blob assembly", async () => {
      let completedBlob: {
        contentId: string;
        data: Uint8Array;
        metadata: any;
      } | null = null;

      const managerWithCallback = new BlobStorageManager({
        storage,
        logger,
        onCompleteBlob: async (contentId, data, metadata) => {
          completedBlob = { contentId, data, metadata };
        },
      });

      const blobPart1: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 2,
        contentId: "test-content-id",
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };

      const blobPart2: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 1,
        totalSegments: 2,
        contentId: "test-content-id",
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([4, 5, 6]),
      };

      await managerWithCallback.handleBlobPart(blobPart1);
      expect(completedBlob).toBeNull(); // Not complete yet

      await managerWithCallback.handleBlobPart(blobPart2);
      expect(completedBlob).not.toBeNull();
      expect(completedBlob!.contentId).toBe("test-content-id");
      expect(completedBlob!.data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
      expect(completedBlob!.metadata).toEqual({
        name: "test.txt",
        contentType: "text/plain",
      });
    });

    it("should handle request blob messages", async () => {
      // First store a complete blob
      const blobPart1: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 2,
        contentId: "test-content-id",
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };

      const blobPart2: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 1,
        totalSegments: 2,
        contentId: "test-content-id",
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([4, 5, 6]),
      };

      await manager.handleBlobPart(blobPart1);
      await manager.handleBlobPart(blobPart2);

      // Now request the blob
      const requestMessage: DecodedRequestBlobMessage = {
        type: "request-blob",
        requestId: "req-123",
        contentId: "test-content-id",
        name: "test.txt",
      };

      const result = await manager.handleRequestBlob(requestMessage);

      expect(result.data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
      expect(result.metadata).toEqual({
        name: "test.txt",
        contentType: "text/plain",
        totalSegments: 2,
        totalSize: 6,
      });
    });

    it("should return null for non-existent blob", async () => {
      const requestMessage: DecodedRequestBlobMessage = {
        type: "request-blob",
        requestId: "req-123",
        contentId: "non-existent",
        name: "test.txt",
      };

      const result = await manager.handleRequestBlob(requestMessage);

      expect(result.data).toBeNull();
      expect(result.metadata).toBeNull();
    });

    it("should return null for incomplete blob", async () => {
      // Store only one part of a two-part blob
      const blobPart: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 2,
        contentId: "test-content-id",
        name: "test.txt",
        contentType: "text/plain",
        data: new Uint8Array([1, 2, 3]),
      };

      await manager.handleBlobPart(blobPart);

      const requestMessage: DecodedRequestBlobMessage = {
        type: "request-blob",
        requestId: "req-123",
        contentId: "test-content-id",
        name: "test.txt",
      };

      const result = await manager.handleRequestBlob(requestMessage);

      expect(result.data).toBeNull();
      expect(result.metadata).toBeNull();
    });
  });
});
