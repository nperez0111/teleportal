import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { DocumentManager } from "./document-manager";
import { Document } from "./document";
import { logger } from "./logger";
import { InMemoryPubSub } from "teleportal";
import type { ServerContext, Message } from "teleportal";
import { DocumentStorage } from "teleportal/storage";

// Mock DocumentStorage for testing
class MockDocumentStorage extends DocumentStorage {
  public encrypted = false;
  public mockFetch = false;
  public mockWrite = false;
  public storedData: any = null;

  async fetch(documentId: string) {
    this.mockFetch = true;
    return this.storedData;
  }

  async write(documentId: string, update: any) {
    this.mockWrite = true;
    this.storedData = update;
  }
}

describe("DocumentManager", () => {
  let documentManager: DocumentManager<ServerContext>;
  let pubSub: InMemoryPubSub;
  let mockGetStorage: any;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    mockGetStorage = () => Promise.resolve(new MockDocumentStorage());

    documentManager = new DocumentManager({
      logger: logger.child().withContext({ name: "test" }),
      getStorage: mockGetStorage,
      pubSub,
      cleanupDelay: 100, // Use a short delay for testing
    });
  });

  afterEach(async () => {
    await documentManager.destroy();
  });

  describe("constructor", () => {
    it("should create a DocumentManager instance", () => {
      expect(documentManager).toBeDefined();
      expect(documentManager.getStats().numDocuments).toBe(0);
    });
  });

  describe("getDocument", () => {
    it("should return undefined for non-existing document", () => {
      const document = documentManager.getDocument("non-existing");
      expect(document).toBeUndefined();
    });

    it("should return document for existing document", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);
      const retrievedDoc = documentManager.getDocument("room/test-doc");

      expect(retrievedDoc).toBe(doc);
    });
  });

  describe("getOrCreateDocument", () => {
    it("should create a new document when it doesn't exist", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);

      expect(doc).toBeInstanceOf(Document);
      expect(doc.id).toBe("room/test-doc");
      expect(doc.name).toBe("test-doc");
      expect(documentManager.getStats().numDocuments).toBe(1);
      // Note: We can't easily test the mock call since it's not a jest mock
    });

    it("should return existing document when it already exists", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc1 = await documentManager.getOrCreateDocument(message);
      const doc2 = await documentManager.getOrCreateDocument(message);

      expect(doc1).toBe(doc2);
      expect(documentManager.getStats().numDocuments).toBe(1);
    });

    it("should emit document-created event when creating new document", async () => {
      let eventEmitted = false;
      let emittedDocument: Document<ServerContext> | undefined;

      documentManager.on(
        "document-created",
        (document: Document<ServerContext>) => {
          eventEmitted = true;
          emittedDocument = document;
        },
      );

      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedDocument).toBe(doc);
    });

    it("should handle storage not found error", async () => {
      // Create a new document manager with a mock that returns null
      const nullStorageManager = new DocumentManager({
        logger: logger.child().withContext({ name: "test" }),
        getStorage: () =>
          Promise.resolve(null) as unknown as Promise<DocumentStorage>,
        pubSub: new InMemoryPubSub(),
      });

      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      await expect(
        nullStorageManager.getOrCreateDocument(message),
      ).rejects.toThrow("Storage not found");

      await nullStorageManager.destroy();
    });
  });

  describe("removeDocument", () => {
    it("should remove existing document", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);
      expect(documentManager.getStats().numDocuments).toBe(1);

      await documentManager.removeDocument("room/test-doc");

      expect(documentManager.getStats().numDocuments).toBe(0);
      expect(documentManager.getDocument("room/test-doc")).toBeUndefined();
    });

    it("should not throw when removing non-existing document", async () => {
      await expect(
        documentManager.removeDocument("non-existing"),
      ).resolves.toBeUndefined();
    });

    it("should emit document-destroyed event when removing document", async () => {
      let eventEmitted = false;
      let emittedDocument: Document<ServerContext> | undefined;

      documentManager.on(
        "document-destroyed",
        (document: Document<ServerContext>) => {
          eventEmitted = true;
          emittedDocument = document;
        },
      );

      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);
      await documentManager.removeDocument("room/test-doc");

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedDocument).toBe(doc);
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", async () => {
      expect(documentManager.getStats()).toEqual({
        numDocuments: 0,
        documentIds: [],
      });

      const message1 = {
        document: "test-doc-1",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const message2 = {
        document: "test-doc-2",
        context: { clientId: "client-2", userId: "user-2", room: "room" },
        encrypted: false,
      };

      await documentManager.getOrCreateDocument(message1);
      await documentManager.getOrCreateDocument(message2);

      const stats = documentManager.getStats();
      expect(stats.numDocuments).toBe(2);
      expect(stats.documentIds).toContain("room/test-doc-1");
      expect(stats.documentIds).toContain("room/test-doc-2");
    });
  });

  describe("destroy", () => {
    it("should destroy all documents and clear the manager", async () => {
      const message1 = {
        document: "test-doc-1",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const message2 = {
        document: "test-doc-2",
        context: { clientId: "client-2", userId: "user-2", room: "room" },
        encrypted: false,
      };

      await documentManager.getOrCreateDocument(message1);
      await documentManager.getOrCreateDocument(message2);

      expect(documentManager.getStats().numDocuments).toBe(2);

      await documentManager.destroy();

      expect(documentManager.getStats().numDocuments).toBe(0);
      expect(documentManager.getStats().documentIds).toEqual([]);
    });

    it("should work with empty manager", async () => {
      await expect(documentManager.destroy()).resolves.toBeUndefined();
      expect(documentManager.getStats().numDocuments).toBe(0);
    });
  });

  describe("document lifecycle", () => {
    it("should automatically remove document when it destroys itself", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);
      expect(documentManager.getStats().numDocuments).toBe(1);

      // Simulate document destroying itself (e.g., when no clients remain)
      await doc.destroy();

      // Wait for the document manager to process the destroy event
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(documentManager.getStats().numDocuments).toBe(0);
    });

    it("should schedule cleanup when document has no clients", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);
      expect(documentManager.getStats().numDocuments).toBe(1);

      // Simulate a client being added and then removed
      const mockClient = { id: "test-client" } as any;
      doc.addClient(mockClient);
      doc.removeClient(mockClient);

      // Document should still exist immediately after client removal
      expect(documentManager.getStats().numDocuments).toBe(1);

      // Wait for cleanup delay
      await new Promise((resolve) => setTimeout(resolve, 150)); // Wait longer than the 100ms delay

      // Document should be removed after cleanup delay
      expect(documentManager.getStats().numDocuments).toBe(0);
    });

    it("should cancel cleanup when client reconnects", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const doc = await documentManager.getOrCreateDocument(message);
      expect(documentManager.getStats().numDocuments).toBe(1);

      // Simulate a client being added and then removed
      const mockClient = {
        id: "test-client",
        unsubscribeFromDocument: () => {},
      } as any;
      doc.addClient(mockClient);
      doc.removeClient(mockClient);

      // Wait a bit but not long enough for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Reconnect client
      doc.addClient(mockClient);

      // Wait for the original cleanup time
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Document should still exist
      expect(documentManager.getStats().numDocuments).toBe(1);
    });
  });
});
