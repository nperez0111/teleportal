import { describe, expect, it, beforeEach } from "bun:test";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  DocMessage,
  StateVector,
  toBinaryTransport,
  Update,
  YBinaryTransport,
} from "teleportal";
import { withEncryption } from "./encrypted";
import {
  createEncryptionKey,
  encryptUpdate,
  decryptUpdate,
} from "../encryption-key";
import { getYTransportFromYDoc } from "./ydoc";

// Helper function to create a proper Update type
function createUpdate(data: Uint8Array): Update {
  return data as Update;
}

function getEncryptedYDocTransport({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  key,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  key: CryptoKey;
}): YBinaryTransport<{
  ydoc: Y.Doc;
  awareness: Awareness;
  synced: Promise<void>;
  key: CryptoKey;
}> {
  let transport = getYTransportFromYDoc({
    ydoc,
    document,
    awareness,
    asClient: true,
  });
  const encryptedTransport = withEncryption(transport, { key });

  return toBinaryTransport(encryptedTransport, {
    clientId: "remote",
  });
}

describe("encrypted-transport", () => {
  let key1: CryptoKey;
  let key2: CryptoKey;

  beforeEach(async () => {
    key1 = await createEncryptionKey();
    key2 = await createEncryptionKey();
  });

  describe("encryption integration", () => {
    it("should encrypt and decrypt updates correctly", async () => {
      const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

      // Test direct encryption/decryption
      const encrypted = await encryptUpdate(key1, testUpdate);
      const decrypted = await decryptUpdate(key1, encrypted);

      expect(decrypted).toEqual(testUpdate);
      expect(encrypted).not.toEqual(testUpdate);
    });

    it("should fail to decrypt with wrong key", async () => {
      const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

      // Encrypt with key1
      const encrypted = await encryptUpdate(key1, testUpdate);

      // Try to decrypt with key2 (wrong key)
      await expect(decryptUpdate(key2, encrypted)).rejects.toThrow();
    });

    it("should handle large updates", async () => {
      const largeUpdate = new Uint8Array(1000);
      for (let i = 0; i < largeUpdate.length; i++) {
        largeUpdate[i] = i % 256;
      }

      const encrypted = await encryptUpdate(key1, createUpdate(largeUpdate));
      const decrypted = await decryptUpdate(key1, encrypted);

      expect(decrypted).toEqual(largeUpdate as Update);
    });

    it("should handle empty updates", async () => {
      const emptyUpdate = createUpdate(new Uint8Array(0));

      const encrypted = await encryptUpdate(key1, emptyUpdate);
      const decrypted = await decryptUpdate(key1, encrypted);

      expect(decrypted).toEqual(emptyUpdate);
    });
  });

  describe("getEncryptedYDocTransport", () => {
    it("should create an encrypted transport with binary encoding", async () => {
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);

      const binaryTransport = getEncryptedYDocTransport({
        ydoc: doc,
        document: "test-doc",
        awareness,
        key: key1,
      });

      expect(binaryTransport).toBeDefined();
      expect(binaryTransport.readable).toBeDefined();
      expect(binaryTransport.writable).toBeDefined();
      expect(binaryTransport.ydoc).toBe(doc);
      expect(binaryTransport.awareness).toBe(awareness);
      expect(binaryTransport.synced).toBeDefined();
    });

    it("should create transport without awareness when not provided", async () => {
      const doc = new Y.Doc();

      const binaryTransport = getEncryptedYDocTransport({
        ydoc: doc,
        document: "test-doc",
        key: key1,
      });

      expect(binaryTransport.awareness).toBeDefined();
      expect(binaryTransport.awareness).toBeInstanceOf(Awareness);
    });

    it("should use different keys for different transports", async () => {
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();

      const transport1 = getEncryptedYDocTransport({
        ydoc: doc1,
        document: "doc1",
        key: key1,
      });

      const transport2 = getEncryptedYDocTransport({
        ydoc: doc2,
        document: "doc2",
        key: key2,
      });

      expect(transport1).toBeDefined();
      expect(transport2).toBeDefined();
      expect(transport1.ydoc).toBe(doc1);
      expect(transport2.ydoc).toBe(doc2);
    });
  });

  describe("withEncryption", () => {
    it("should wrap a transport with encryption", async () => {
      const doc = new Y.Doc();
      const transport = getYTransportFromYDoc({
        ydoc: doc,
        document: "test",
        asClient: false,
      });

      const encryptedTransport = withEncryption(transport, { key: key1 });

      expect(encryptedTransport).toBeDefined();
      expect(encryptedTransport.readable).toBeDefined();
      expect(encryptedTransport.writable).toBeDefined();
    });

    it("should handle awareness messages through encrypted transport", async () => {
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      const transport = getYTransportFromYDoc({
        ydoc: doc,
        awareness,
        document: "test",
        asClient: false,
      });

      const encryptedTransport = withEncryption(transport, { key: key1 });

      expect(encryptedTransport).toBeDefined();
      expect(encryptedTransport.readable).toBeDefined();
      expect(encryptedTransport.writable).toBeDefined();
    });
  });

  describe("message creation", () => {
    it("should create doc messages with update payload", () => {
      const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

      const message = new DocMessage(
        "test-doc",
        { type: "update", update: testUpdate },
        { clientId: "test" },
        false,
      );

      expect(message.type).toBe("doc");
      expect(message.document).toBe("test-doc");
      expect(message.context.clientId).toBe("test");
      expect(message.payload.type).toBe("update");
      if (message.payload.type === "update") {
        expect(message.payload.update).toEqual(testUpdate);
      } else {
        throw new Error("Message is not an update");
      }
    });

    it("should create doc messages with sync-step-2 payload", () => {
      const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-2", update: testUpdate },
        { clientId: "test" },
        false,
      );

      expect(message.type).toBe("doc");
      expect(message.payload.type).toBe("sync-step-2");
      if (message.payload.type === "sync-step-2") {
        expect(message.payload.update).toEqual(testUpdate);
      } else {
        throw new Error("Message is not a sync-step-2");
      }
    });

    it("should create doc messages with sync-step-1 payload", () => {
      const stateVector = new Uint8Array([1, 2, 3]) as StateVector;

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: stateVector },
        { clientId: "test" },
        false,
      );

      expect(message.type).toBe("doc");
      expect(message.payload.type).toBe("sync-step-1");
      if (message.payload.type === "sync-step-1") {
        expect(message.payload.sv).toEqual(stateVector);
      } else {
        throw new Error("Message is not a sync-step-1");
      }
    });
  });

  describe("key management", () => {
    it("should create unique keys", async () => {
      const key1 = await createEncryptionKey();
      const key2 = await createEncryptionKey();

      expect(key1).not.toBe(key2);
    });

    it("should handle multiple keys independently", async () => {
      const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

      // Encrypt with key1
      const encrypted1 = await encryptUpdate(key1, testUpdate);

      // Encrypt with key2
      const encrypted2 = await encryptUpdate(key2, testUpdate);

      // The encrypted outputs should be different
      expect(encrypted1).not.toEqual(encrypted2);

      // Decrypt with respective keys
      const decrypted1 = await decryptUpdate(key1, encrypted1);
      const decrypted2 = await decryptUpdate(key2, encrypted2);

      expect(decrypted1).toEqual(testUpdate);
      expect(decrypted2).toEqual(testUpdate);

      // Try to decrypt with wrong key - should fail
      await expect(decryptUpdate(key2, encrypted1)).rejects.toThrow();
      await expect(decryptUpdate(key1, encrypted2)).rejects.toThrow();
    });
  });
});
