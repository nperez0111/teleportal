import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import type { StateVector, Update } from "teleportal";
import { getEmptyStateVector, getEmptyUpdate } from "../../lib/protocol/utils";
import { YDocStorage } from "./ydoc";
import type { FileStorage } from "../types";

describe("YDocStorage", () => {
  let storage: YDocStorage;
  let mockFileStorage: FileStorage;

  beforeEach(() => {
    // Clear static maps before each test
    YDocStorage.docs.clear();
    YDocStorage.metadata.clear();
    storage = new YDocStorage();
  });

  describe("handleUpdate", () => {
    it("should create a new document if it doesn't exist", async () => {
      const key = "test-doc-1";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Hello, World!");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, update);

      expect(YDocStorage.docs.has(key)).toBe(true);
      const storedDoc = YDocStorage.docs.get(key)!;
      expect(storedDoc.getText("content").toString()).toBe("Hello, World!");
    });

    it("should apply updates to existing document", async () => {
      const key = "test-doc-2";
      const doc1 = new Y.Doc();
      const text1 = doc1.getText("content");
      text1.insert(0, "Hello");
      const update1 = Y.encodeStateAsUpdateV2(doc1) as Update;

      await storage.handleUpdate(key, update1);

      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      const text2 = doc2.getText("content");
      text2.insert(5, ", World!");
      const update2 = Y.encodeStateAsUpdateV2(doc2) as Update;

      await storage.handleUpdate(key, update2);

      const storedDoc = YDocStorage.docs.get(key)!;
      expect(storedDoc.getText("content").toString()).toBe("Hello, World!");
    });

    it("should update metadata updatedAt timestamp", async () => {
      const key = "test-doc-3";
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      const beforeTime = Date.now();
      await storage.handleUpdate(key, update);
      const afterTime = Date.now();

      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(metadata.updatedAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("getDocument", () => {
    it("should create and return document for non-existent document", async () => {
      const doc = await storage.getDocument("non-existent");
      expect(doc).not.toBeNull();
      expect(doc!.id).toBe("non-existent");
      expect(doc!.metadata).toBeDefined();
      expect(doc!.content).toBeDefined();
    });

    it("should return document with correct structure", async () => {
      const key = "test-doc-4";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Test content");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, update);

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(key);
      expect(retrieved!.metadata).toBeDefined();
      expect(retrieved!.content).toBeDefined();
      expect(retrieved!.content.update).toBeInstanceOf(Uint8Array);
      expect(retrieved!.content.stateVector).toBeInstanceOf(Uint8Array);
    });

    it("should return document that can be applied to a new Y.Doc", async () => {
      const key = "test-doc-5";
      const originalDoc = new Y.Doc();
      const text = originalDoc.getText("content");
      text.insert(0, "Original content");
      const update = Y.encodeStateAsUpdateV2(originalDoc) as Update;

      await storage.handleUpdate(key, update);

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();

      const newDoc = new Y.Doc();
      Y.applyUpdateV2(newDoc, retrieved!.content.update);
      expect(newDoc.getText("content").toString()).toBe("Original content");
    });

    it("should create document if it doesn't exist when getting", async () => {
      const key = "test-doc-6";
      const doc = await storage.getDocument(key);

      expect(doc).not.toBeNull();
      expect(doc!.id).toBe(key);
      expect(YDocStorage.docs.has(key)).toBe(true);
    });
  });

  describe("writeDocumentMetadata and getDocumentMetadata", () => {
    it("should write and retrieve metadata", async () => {
      const key = "test-doc-7";
      const metadata = {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: false,
      };

      await storage.writeDocumentMetadata(key, metadata);
      const retrieved = await storage.getDocumentMetadata(key);

      expect(retrieved.createdAt).toBe(1000);
      expect(retrieved.updatedAt).toBe(2000);
      expect(retrieved.encrypted).toBe(false);
    });

    it("should return default metadata for non-existent document", async () => {
      const key = "test-doc-8";
      const metadata = await storage.getDocumentMetadata(key);

      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(metadata.encrypted).toBe(false);
    });

    it("should normalize invalid metadata values", async () => {
      const key = "test-doc-9";
      // Manually set invalid metadata
      YDocStorage.metadata.set(key, {
        createdAt: "invalid" as any,
        updatedAt: "invalid" as any,
        encrypted: "invalid" as any,
      });

      const metadata = await storage.getDocumentMetadata(key);
      const now = Date.now();

      expect(typeof metadata.createdAt).toBe("number");
      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(typeof metadata.updatedAt).toBe("number");
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(typeof metadata.encrypted).toBe("boolean");
      expect(metadata.encrypted).toBe(false);
    });
  });

  describe("deleteDocument", () => {
    it("should delete document and metadata", async () => {
      const key = "test-doc-10";
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, update);
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: false,
      });

      expect(YDocStorage.docs.has(key)).toBe(true);
      expect(YDocStorage.metadata.has(key)).toBe(true);

      await storage.deleteDocument(key);

      expect(YDocStorage.docs.has(key)).toBe(false);
      expect(YDocStorage.metadata.has(key)).toBe(false);
    });

    it("should cascade delete files when fileStorage is provided", async () => {
      const key = "test-doc-11";
      let deleteFilesByDocumentCalled = false;
      let deleteFilesByDocumentKey: string | undefined;

      mockFileStorage = {
        type: "file-storage" as const,
        getFile: async () => null,
        deleteFile: async () => {},
        listFileMetadataByDocument: async () => [],
        deleteFilesByDocument: async (documentId: string) => {
          deleteFilesByDocumentCalled = true;
          deleteFilesByDocumentKey = documentId;
        },
        storeFileFromUpload: async () => {},
      };

      storage = new YDocStorage(mockFileStorage);
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, update);
      await storage.deleteDocument(key);

      expect(deleteFilesByDocumentCalled).toBe(true);
      expect(deleteFilesByDocumentKey).toBe(key);
    });

    it("should not fail if fileStorage is not provided", async () => {
      const key = "test-doc-12";
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, update);

      await storage.deleteDocument(key);
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("handleSyncStep1", () => {
    it("should return document with diff update", async () => {
      const key = "test-doc-13";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Full content");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, update);

      const emptyStateVector = getEmptyStateVector();

      const result = await storage.handleSyncStep1(key, emptyStateVector);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
      expect(result.content.update).toBeInstanceOf(Uint8Array);
      expect(result.content.stateVector).toBeInstanceOf(Uint8Array);
    });

    it("should return empty document for non-existent document", async () => {
      const key = "test-doc-14";
      const emptyStateVector = getEmptyStateVector();

      const result = await storage.handleSyncStep1(key, emptyStateVector);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
    });
  });

  describe("handleSyncStep2", () => {
    it("should apply sync step 2 update", async () => {
      const key = "test-doc-15";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Sync content");
      const syncStep2 = Y.encodeStateAsUpdateV2(doc) as any;

      await storage.handleSyncStep2(key, syncStep2);

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const newDoc = new Y.Doc();
      Y.applyUpdateV2(newDoc, retrieved!.content.update);
      expect(newDoc.getText("content").toString()).toBe("Sync content");
    });
  });

  describe("transaction", () => {
    it("should execute transaction callback", async () => {
      const key = "test-doc-16";
      let executed = false;

      await storage.transaction(key, async () => {
        executed = true;
        return "result";
      });

      expect(executed).toBe(true);
    });

    it("should return transaction result", async () => {
      const key = "test-doc-17";
      const result = await storage.transaction(key, async () => {
        return "test-result";
      });

      expect(result).toBe("test-result");
    });
  });
});

