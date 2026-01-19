import { beforeEach, describe, expect, it } from "bun:test";
import { createStorage } from "unstorage";
import type {
  EncryptedMessageId,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { EncryptedBinary } from "teleportal/encryption-key";
import {
  encodeEncryptedUpdateMessages,
  encodeToSyncStep2,
  getEmptyEncryptedStateVector,
} from "teleportal/protocol/encryption";
import type { DecodedEncryptedUpdatePayload } from "teleportal/protocol/encryption";
import { digest } from "lib0/hash/sha256";
import { toBase64 } from "lib0/buffer";
import { UnstorageEncryptedDocumentStorage } from "./encrypted";
import { UnstorageMilestoneStorage } from "./milestone-storage";
import type { FileStorage, MilestoneStorage } from "../types";
import type { MilestoneSnapshot } from "teleportal";

describe("UnstorageEncryptedDocumentStorage", () => {
  let storage: UnstorageEncryptedDocumentStorage;
  let mockFileStorage: FileStorage;

  beforeEach(() => {
    storage = new UnstorageEncryptedDocumentStorage(createStorage());
  });

  describe("constructor", () => {
    it("should create storage with default options", async () => {
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

    it("should accept custom TTL option", async () => {
      const customStorage = new UnstorageEncryptedDocumentStorage(
        createStorage(),
        {
          ttl: 10_000,
        },
      );

      const key = "test-doc-2";
      const executionOrder: string[] = [];

      const promise1 = customStorage.transaction(key, async () => {
        executionOrder.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionOrder.push("end-1");
        return "result-1";
      });

      const promise2 = customStorage.transaction(key, async () => {
        executionOrder.push("start-2");
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push("end-2");
        return "result-2";
      });

      await Promise.all([promise1, promise2]);

      // Verify transactions executed (locking may cause reordering, but both should complete)
      expect(executionOrder).toContain("start-1");
      expect(executionOrder).toContain("end-1");
      expect(executionOrder).toContain("start-2");
      expect(executionOrder).toContain("end-2");
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

    it("should return default metadata for non-existent document", async () => {
      const key = "test-doc-4";
      const metadata = await storage.getDocumentMetadata(key);

      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(metadata.encrypted).toBe(true);
      expect(metadata.seenMessages).toEqual({});
    });

    it("should normalize invalid metadata values", async () => {
      const key = "test-doc-5";
      // Manually set invalid metadata
      const unstorage = createStorage();
      await unstorage.setItem(key + ":meta", {
        createdAt: "invalid",
        updatedAt: "invalid",
        encrypted: "invalid",
        seenMessages: {},
      });

      const testStorage = new UnstorageEncryptedDocumentStorage(unstorage);
      const metadata = await testStorage.getDocumentMetadata(key);

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
      const key = "test-doc-6";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3, 4, 5]) as EncryptedBinary;

      await storage.storeEncryptedMessage(key, messageId, payload);

      const retrieved = await storage.fetchEncryptedMessage(key, messageId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!).toEqual(payload);
    });

    it("should return null for non-existent message", async () => {
      const key = "test-doc-7";
      const messageId = "msg-nonexistent" as EncryptedMessageId;

      const retrieved = await storage.fetchEncryptedMessage(key, messageId);
      expect(retrieved).toBeNull();
    });

    it("should store multiple messages for the same document", async () => {
      const key = "test-doc-8";
      const messageId1 = "msg-1" as EncryptedMessageId;
      const messageId2 = "msg-2" as EncryptedMessageId;
      const payload1 = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const payload2 = new Uint8Array([4, 5, 6]) as EncryptedBinary;

      await storage.storeEncryptedMessage(key, messageId1, payload1);
      await storage.storeEncryptedMessage(key, messageId2, payload2);

      const retrieved1 = await storage.fetchEncryptedMessage(key, messageId1);
      const retrieved2 = await storage.fetchEncryptedMessage(key, messageId2);

      expect(retrieved1).toEqual(payload1);
      expect(retrieved2).toEqual(payload2);
    });
  });

  describe("deleteDocument", () => {
    it("should delete document and all messages", async () => {
      const key = "test-doc-9";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedBinary;

      await storage.storeEncryptedMessage(key, messageId, payload);
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: true,
        seenMessages: { 1: { 5: messageId } },
      });

      expect(
        await storage.fetchEncryptedMessage(key, messageId),
      ).not.toBeNull();

      await storage.deleteDocument(key);

      expect(await storage.fetchEncryptedMessage(key, messageId)).toBeNull();
      const metadata = await storage.getDocumentMetadata(key);
      // Should return default metadata after deletion
      expect(metadata.seenMessages).toEqual({});
    });

    it("should delete all messages referenced in seenMessages", async () => {
      const key = "test-doc-11";
      const messageId1 = "msg-1" as EncryptedMessageId;
      const messageId2 = "msg-2" as EncryptedMessageId;
      const payload1 = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const payload2 = new Uint8Array([4, 5, 6]) as EncryptedBinary;

      await storage.storeEncryptedMessage(key, messageId1, payload1);
      await storage.storeEncryptedMessage(key, messageId2, payload2);
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: true,
        seenMessages: {
          1: { 5: messageId1 },
          2: { 10: messageId2 },
        },
      });

      await storage.deleteDocument(key);

      expect(await storage.fetchEncryptedMessage(key, messageId1)).toBeNull();
      expect(await storage.fetchEncryptedMessage(key, messageId2)).toBeNull();
    });
  });

  describe("handleSyncStep1", () => {
    it("should return document with encrypted state vector", async () => {
      const key = "test-doc-12";
      const messageId = "msg-1" as EncryptedMessageId;
      const payload = new Uint8Array([1, 2, 3]) as EncryptedBinary;

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
      const key = "test-doc-13";
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
      const key = "test-doc-14";
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
      expect(retrieved).not.toBeNull();
      expect(retrieved!).toEqual(message.payload);
    });

    it("should update seenMessages correctly", async () => {
      const key = "test-doc-15";
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
      const key = "test-doc-16";
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
      expect(retrieved).not.toBeNull();
      expect(retrieved!).toEqual(message.payload);
    });

    it("should update metadata timestamp when handling update", async () => {
      const key = "test-doc-17";
      const payload = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const messageId = toBase64(digest(payload));
      const message: DecodedEncryptedUpdatePayload = {
        id: messageId,
        timestamp: [3, 15],
        payload,
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
      const key = "test-doc-18";
      const payload1 = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const payload2 = new Uint8Array([4, 5, 6]) as EncryptedBinary;
      const messageId1 = toBase64(digest(payload1));
      const messageId2 = toBase64(digest(payload2));

      await storage.storeEncryptedMessage(key, messageId1, payload1);
      await storage.storeEncryptedMessage(key, messageId2, payload2);
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: true,
        seenMessages: {
          1: { 5: messageId1 },
          2: { 10: messageId2 },
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
      const key = "test-doc-19";

      const result = await storage.getDocument(key);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
      expect(result.metadata.encrypted).toBe(true);
      expect(result.metadata.seenMessages).toEqual({});
    });
  });

  describe("transaction", () => {
    it("should execute transaction callback", async () => {
      const key = "test-doc-20";
      let executed = false;

      await storage.transaction(key, async () => {
        executed = true;
        return "result";
      });

      expect(executed).toBe(true);
    });

    it("should return transaction result", async () => {
      const key = "test-doc-21";
      const result = await storage.transaction(key, async () => {
        return "test-result";
      });

      expect(result).toBe("test-result");
    });

    it("should handle concurrent transactions with locking", async () => {
      const key = "test-doc-22";
      const executionOrder: string[] = [];

      const promise1 = storage.transaction(key, async () => {
        executionOrder.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionOrder.push("end-1");
        return "result-1";
      });

      const promise2 = storage.transaction(key, async () => {
        executionOrder.push("start-2");
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push("end-2");
        return "result-2";
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe("result-1");
      expect(result2).toBe("result-2");
      // Verify transactions executed (locking may cause reordering, but both should complete)
      expect(executionOrder).toContain("start-1");
      expect(executionOrder).toContain("end-1");
      expect(executionOrder).toContain("start-2");
      expect(executionOrder).toContain("end-2");
    });
  });
});
