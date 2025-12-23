import { beforeEach, describe, expect, it } from "bun:test";
import type {
  EncryptedMessageId,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import type { Update } from "teleportal";
import { EncryptedBinary } from "teleportal/encryption-key";
import { EncryptedMemoryStorage } from "./encrypted";
import type { FileStorage } from "../types";
import {
  encodeEncryptedUpdateMessages,
  encodeToSyncStep2,
  getEmptyEncryptedStateVector,
} from "teleportal/protocol/encryption";
import type { DecodedEncryptedUpdatePayload } from "teleportal/protocol/encryption";
import { digest } from "lib0/hash/sha256";
import { toBase64 } from "lib0/buffer";

describe("EncryptedMemoryStorage", () => {
  let storage: EncryptedMemoryStorage;
  let mockFileStorage: FileStorage;

  beforeEach(() => {
    // Clear static map before each test
    EncryptedMemoryStorage.docs.clear();
    storage = new EncryptedMemoryStorage();
  });

  describe("constructor", () => {
    it("should use default write and fetch if not provided", async () => {
      const key = "test-doc-1";
      const metadata = {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: true,
        seenMessages: {},
      };

      await storage.writeDocumentMetadata(key, metadata);
      const retrieved = await storage.getDocumentMetadata(key);

      expect(retrieved.createdAt).toBe(1000);
      expect(retrieved.updatedAt).toBe(2000);
    });

    it("should use custom write and fetch if provided", async () => {
      const customDocs = new Map<
        string,
        {
          metadata: any;
          updates: Map<EncryptedMessageId, EncryptedUpdatePayload>;
        }
      >();

      const customWrite = async (key: string, doc: any) => {
        customDocs.set(key, doc);
      };
      const customFetch = async (key: string) => {
        return customDocs.get(key);
      };

      storage = new EncryptedMemoryStorage(
        {
          write: customWrite,
          fetch: customFetch,
        },
        undefined,
      );

      const key = "test-doc-2";
      const metadata = {
        createdAt: 2000,
        updatedAt: 3000,
        encrypted: true,
        seenMessages: {},
      };

      await storage.writeDocumentMetadata(key, metadata);
      const retrieved = await storage.getDocumentMetadata(key);

      expect(retrieved.createdAt).toBe(2000);
      expect(customDocs.has(key)).toBe(true);
    });
  });

  describe("writeDocumentMetadata and getDocumentMetadata", () => {
    it("should write and retrieve metadata", async () => {
      const key = "test-doc-3";
      const metadata = {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: true,
        seenMessages: { 1: { 5: "msg-id-1" } },
      };

      await storage.writeDocumentMetadata(key, metadata);
      const retrieved = await storage.getDocumentMetadata(key);

      expect(retrieved.createdAt).toBe(1000);
      expect(retrieved.updatedAt).toBe(2000);
      expect(retrieved.encrypted).toBe(true);
      expect(retrieved.seenMessages).toEqual({ 1: { 5: "msg-id-1" } });
    });

    it("should preserve existing updates when writing metadata", async () => {
      const key = "test-doc-4";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId, payload);

      const newMetadata = {
        createdAt: 3000,
        updatedAt: 4000,
        encrypted: true,
        seenMessages: { 1: { 5: messageId } },
      };

      await storage.writeDocumentMetadata(key, newMetadata);

      const retrieved = await storage.fetchEncryptedMessage(key, messageId);
      expect(retrieved).toEqual(payload);
    });

    it("should return default metadata for non-existent document", async () => {
      const key = "test-doc-5";
      const metadata = await storage.getDocumentMetadata(key);

      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(metadata.encrypted).toBe(true);
      expect(metadata.seenMessages).toEqual({});
    });

    it("should normalize invalid metadata values", async () => {
      const key = "test-doc-6";
      // Manually set invalid metadata
      EncryptedMemoryStorage.docs.set(key, {
        metadata: {
          createdAt: "invalid" as any,
          updatedAt: "invalid" as any,
          encrypted: "invalid" as any,
          seenMessages: {},
        },
        updates: new Map(),
      });

      const metadata = await storage.getDocumentMetadata(key);

      expect(typeof metadata.createdAt).toBe("number");
      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(typeof metadata.updatedAt).toBe("number");
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(typeof metadata.encrypted).toBe("boolean");
      expect(metadata.encrypted).toBe(true);
    });
  });

  describe("storeEncryptedMessage and fetchEncryptedMessage", () => {
    it("should store and retrieve encrypted message", async () => {
      const key = "test-doc-7";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3, 4, 5]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId, payload);

      const retrieved = await storage.fetchEncryptedMessage(key, messageId);
      expect(retrieved).toEqual(payload);
    });

    it("should create document metadata if it doesn't exist when storing", async () => {
      const key = "test-doc-8";
      const messageId = "msg-2" as EncryptedMessageId;
      const payload = new Uint8Array([10, 20, 30]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId, payload);

      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(metadata.encrypted).toBe(true);
    });

    it("should throw error when fetching non-existent document", async () => {
      const key = "test-doc-9";
      const messageId = "msg-3" as EncryptedMessageId;

      await expect(
        storage.fetchEncryptedMessage(key, messageId),
      ).rejects.toThrow("Document not found");
    });

    it("should throw error when fetching non-existent message", async () => {
      const key = "test-doc-10";
      const messageId1 = "msg-1" as EncryptedMessageId;
      const messageId2 = "msg-2" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId1, payload);

      await expect(
        storage.fetchEncryptedMessage(key, messageId2),
      ).rejects.toThrow("Message not found");
    });

    it("should store multiple messages for the same document", async () => {
      const key = "test-doc-11";
      const messageId1 = "msg-1" as EncryptedMessageId;
      const messageId2 = "msg-2" as EncryptedMessageId;
      const payload1 = new Uint8Array([1, 2, 3]) as EncryptedUpdatePayload;
      const payload2 = new Uint8Array([4, 5, 6]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(
        key,
        messageId1,
        payload1 as EncryptedUpdatePayload,
      );
      await storage.storeEncryptedMessage(
        key,
        messageId2,
        payload2 as EncryptedUpdatePayload,
      );

      const retrieved1 = await storage.fetchEncryptedMessage(key, messageId1);
      const retrieved2 = await storage.fetchEncryptedMessage(key, messageId2);

      expect(retrieved1).toEqual(payload1);
      expect(retrieved2).toEqual(payload2);
    });
  });

  describe("deleteDocument", () => {
    it("should delete document and all messages", async () => {
      const key = "test-doc-12";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId, payload);
      expect(EncryptedMemoryStorage.docs.has(key)).toBe(true);

      await storage.deleteDocument(key);

      expect(EncryptedMemoryStorage.docs.has(key)).toBe(false);
      await expect(
        storage.fetchEncryptedMessage(key, messageId),
      ).rejects.toThrow("Document not found");
    });

    it("should cascade delete files when fileStorage is provided", async () => {
      const key = "test-doc-13";
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

      storage = new EncryptedMemoryStorage(undefined, mockFileStorage);
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId, payload);
      await storage.deleteDocument(key);

      expect(deleteFilesByDocumentCalled).toBe(true);
      expect(deleteFilesByDocumentKey).toBe(key);
    });

    it("should not fail if fileStorage is not provided", async () => {
      const key = "test-doc-14";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId, payload);

      await storage.deleteDocument(key);
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("handleSyncStep1", () => {
    it("should return document with encrypted state vector", async () => {
      const key = "test-doc-15";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedUpdatePayload;

      await storage.storeEncryptedMessage(key, messageId, payload);
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: true,
        seenMessages: { 1: { 5: messageId } },
      });

      const emptyStateVector = getEmptyEncryptedStateVector();
      const result = await storage.handleSyncStep1(key, emptyStateVector);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
      expect(result.metadata.encrypted).toBe(true);
      expect(result.content.update).toBeInstanceOf(Uint8Array);
      expect(result.content.stateVector).toBeInstanceOf(Uint8Array);
    });

    it("should return document with default metadata for non-existent document", async () => {
      const key = "test-doc-16";
      const emptyStateVector = getEmptyEncryptedStateVector();

      const result = await storage.handleSyncStep1(key, emptyStateVector);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
      expect(result.metadata.encrypted).toBe(true);
      expect(result.metadata.seenMessages).toEqual({});
    });
  });

  describe("handleSyncStep2", () => {
    it("should store messages from sync step 2", async () => {
      const key = "test-doc-17";
      const payload = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const messageId = toBase64(digest(payload));
      const message: DecodedEncryptedUpdatePayload = {
        id: messageId,
        timestamp: [1, 5],
        payload,
      };

      const syncStep2 = encodeToSyncStep2({ messages: [message] });

      await storage.handleSyncStep2(key, syncStep2);

      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.seenMessages[1]).toBeDefined();
      expect(metadata.seenMessages[1][5]).toBe(messageId);

      const retrieved = await storage.fetchEncryptedMessage(key, messageId);
      expect(retrieved).toEqual(message.payload as EncryptedUpdatePayload);
    });

    it("should update seenMessages correctly", async () => {
      const key = "test-doc-18";
      const payload1 = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const payload2 = new Uint8Array([4, 5, 6]) as EncryptedBinary;
      const messageId1 = toBase64(digest(payload1));
      const messageId2 = toBase64(digest(payload2));
      const message1: DecodedEncryptedUpdatePayload = {
        id: messageId1,
        timestamp: [1, 5],
        payload: payload1,
      };
      const message2: DecodedEncryptedUpdatePayload = {
        id: messageId2,
        timestamp: [1, 6],
        payload: payload2,
      };

      const syncStep2 = encodeToSyncStep2({ messages: [message1, message2] });

      await storage.handleSyncStep2(key, syncStep2);

      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.seenMessages[1][5]).toBe(messageId1);
      expect(metadata.seenMessages[1][6]).toBe(messageId2);
    });
  });

  describe("handleUpdate", () => {
    it("should store encrypted update messages", async () => {
      const key = "test-doc-19";
      const payload = new Uint8Array([10, 20, 30]) as EncryptedBinary;
      const messageId = toBase64(digest(payload));
      const message: DecodedEncryptedUpdatePayload = {
        id: messageId,
        timestamp: [2, 10],
        payload,
      };

      const update = encodeEncryptedUpdateMessages([message]);

      await storage.handleUpdate(key, update);

      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.seenMessages[2]).toBeDefined();
      expect(metadata.seenMessages[2][10]).toBe(messageId);

      const retrieved = await storage.fetchEncryptedMessage(key, messageId);
      expect(retrieved).toEqual(message.payload as EncryptedUpdatePayload);
    });

    it("should update metadata timestamp when handling update", async () => {
      const key = "test-doc-20";
      const message: DecodedEncryptedUpdatePayload = {
        id: "msg-1",
        timestamp: [3, 15],
        payload: new Uint8Array([1, 2, 3]) as EncryptedBinary,
      };

      const update = encodeEncryptedUpdateMessages([message]);

      const beforeTime = Date.now();
      await storage.handleUpdate(key, update);
      const afterTime = Date.now();

      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(metadata.updatedAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("getDocument", () => {
    it("should return document with all stored messages", async () => {
      const key = "test-doc-21";
      const message1: DecodedEncryptedUpdatePayload = {
        id: "msg-1",
        timestamp: [1, 5],
        payload: new Uint8Array([1, 2, 3]) as EncryptedBinary,
      };
      const message2: DecodedEncryptedUpdatePayload = {
        id: "msg-2",
        timestamp: [2, 10],
        payload: new Uint8Array([4, 5, 6]) as EncryptedBinary,
      };

      await storage.storeEncryptedMessage(
        key,
        message1.id,
        message1.payload as EncryptedUpdatePayload,
      );
      await storage.storeEncryptedMessage(
        key,
        message2.id,
        message2.payload as EncryptedUpdatePayload,
      );
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: true,
        seenMessages: {
          1: { 5: message1.id },
          2: { 10: message2.id },
        },
      });

      const result = await storage.getDocument(key);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
      expect(result.metadata.encrypted).toBe(true);
      expect(result.content.update).toBeInstanceOf(Uint8Array);
      expect(result.content.stateVector).toBeInstanceOf(Uint8Array);
    });

    it("should return document with default metadata if none exists", async () => {
      const key = "test-doc-22";

      const result = await storage.getDocument(key);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
      expect(result.metadata.encrypted).toBe(true);
      expect(result.metadata.seenMessages).toEqual({});
    });
  });

  describe("transaction", () => {
    it("should execute transaction callback", async () => {
      const key = "test-doc-23";
      let executed = false;

      await storage.transaction(key, async () => {
        executed = true;
        return "result";
      });

      expect(executed).toBe(true);
    });

    it("should return transaction result", async () => {
      const key = "test-doc-24";
      const result = await storage.transaction(key, async () => {
        return "test-result";
      });

      expect(result).toBe("test-result");
    });
  });
});
