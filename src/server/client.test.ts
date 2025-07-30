import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Client } from "./client";
import { logger } from "./logger";
import { DocMessage } from "teleportal";
import type { ServerContext, Message } from "teleportal";

// Mock Document class for testing
class MockDocument<Context extends ServerContext> {
  public id: string;
  public clients = new Set<Client<Context>>();
  public mockAddClient = false;
  public mockRemoveClient = false;

  constructor(id: string) {
    this.id = id;
  }

  addClient(client: Client<Context>): void {
    this.mockAddClient = true;
    this.clients.add(client);
  }

  removeClient(client: Client<Context>): void {
    this.mockRemoveClient = true;
    this.clients.delete(client);
  }
}

describe("Client", () => {
  let client: Client<ServerContext>;
  let writable: WritableStream<Message<ServerContext>>;

  beforeEach(() => {
    // Create a mock writable stream
    writable = new WritableStream({
      write(chunk) {
        // Mock implementation
      },
    });

    client = new Client({
      id: "test-client",
      writable,
      logger: logger.child().withContext({ name: "test" }),
    });
  });

  afterEach(async () => {
    await client.destroy();
  });

  describe("constructor", () => {
    it("should create a Client instance", () => {
      expect(client).toBeDefined();
      expect(client.id).toBe("test-client");
      expect(client.documents.size).toBe(0);
    });
  });

  describe("send", () => {
    it("should send a message successfully", async () => {
      const mockMessage = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "test-client", userId: "test-user", room: "test-room" },
        false,
      );

      // This should not throw
      await expect(client.send(mockMessage)).resolves.toBeUndefined();
    });
  });

  describe("subscribeToDocument", () => {
    it("should subscribe to a document", () => {
      const mockDocument = new MockDocument<ServerContext>("test-doc");

      client.subscribeToDocument(mockDocument as any);

      expect(client.documents.has(mockDocument as any)).toBe(true);
      expect(client.getDocumentCount()).toBe(1);
      expect(mockDocument.mockAddClient).toBe(true);
    });

    it("should not subscribe to the same document twice", () => {
      const mockDocument = new MockDocument<ServerContext>("test-doc");

      client.subscribeToDocument(mockDocument as any);
      client.subscribeToDocument(mockDocument as any);

      expect(client.getDocumentCount()).toBe(1);
      expect(mockDocument.clients.size).toBe(1);
    });

    it("should emit document-added event", async () => {
      const mockDocument = new MockDocument<ServerContext>("test-doc");
      let eventEmitted = false;
      let emittedDocument: MockDocument<ServerContext> | undefined;

      client.on("document-added", (document: any) => {
        eventEmitted = true;
        emittedDocument = document;
      });

      client.subscribeToDocument(mockDocument as any);

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedDocument).toBe(mockDocument);
    });
  });

  describe("unsubscribeFromDocument", () => {
    it("should unsubscribe from a document", () => {
      const mockDocument = new MockDocument<ServerContext>("test-doc");

      client.subscribeToDocument(mockDocument as any);
      expect(client.getDocumentCount()).toBe(1);

      client.unsubscribeFromDocument(mockDocument as any);

      expect(client.documents.has(mockDocument as any)).toBe(false);
      expect(client.getDocumentCount()).toBe(0);
      expect(mockDocument.mockRemoveClient).toBe(true);
    });

    it("should not unsubscribe from a document not subscribed to", () => {
      const mockDocument = new MockDocument<ServerContext>("test-doc");

      client.unsubscribeFromDocument(mockDocument as any);

      expect(client.getDocumentCount()).toBe(0);
      expect(mockDocument.mockRemoveClient).toBe(false);
    });

    it("should emit document-removed event", async () => {
      const mockDocument = new MockDocument<ServerContext>("test-doc");
      let eventEmitted = false;
      let emittedDocument: MockDocument<ServerContext> | undefined;

      client.on("document-removed", (document: any) => {
        eventEmitted = true;
        emittedDocument = document;
      });

      client.subscribeToDocument(mockDocument as any);
      client.unsubscribeFromDocument(mockDocument as any);

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedDocument).toBe(mockDocument);
    });
  });

  describe("getDocumentCount", () => {
    it("should return correct document count", () => {
      expect(client.getDocumentCount()).toBe(0);

      const mockDocument1 = new MockDocument<ServerContext>("test-doc-1");
      const mockDocument2 = new MockDocument<ServerContext>("test-doc-2");

      client.subscribeToDocument(mockDocument1 as any);
      expect(client.getDocumentCount()).toBe(1);

      client.subscribeToDocument(mockDocument2 as any);
      expect(client.getDocumentCount()).toBe(2);

      client.unsubscribeFromDocument(mockDocument1 as any);
      expect(client.getDocumentCount()).toBe(1);
    });
  });

  describe("destroy", () => {
    it("should destroy client and unsubscribe from all documents", async () => {
      const mockDocument1 = new MockDocument<ServerContext>("test-doc-1");
      const mockDocument2 = new MockDocument<ServerContext>("test-doc-2");

      client.subscribeToDocument(mockDocument1 as any);
      client.subscribeToDocument(mockDocument2 as any);
      expect(client.getDocumentCount()).toBe(2);

      await client.destroy();

      expect(client.getDocumentCount()).toBe(0);
      expect(mockDocument1.mockRemoveClient).toBe(true);
      expect(mockDocument2.mockRemoveClient).toBe(true);
    });

    it("should emit destroy event", async () => {
      let eventEmitted = false;
      let emittedClient: Client<ServerContext> | undefined;

      client.on("destroy", (client: Client<ServerContext>) => {
        eventEmitted = true;
        emittedClient = client;
      });

      await client.destroy();

      expect(eventEmitted).toBe(true);
      expect(emittedClient).toBe(client);
    });

    it("should not destroy twice", async () => {
      await client.destroy();
      await client.destroy(); // Should not throw or cause issues

      expect(client.getDocumentCount()).toBe(0);
    });

    it("should handle writer release lock errors", async () => {
      await client.destroy();

      // Should not throw and should still clean up
      expect(client.getDocumentCount()).toBe(0);
    });

    it("should handle writer abort errors", async () => {
      await client.destroy();

      // Should not throw and should still clean up
      expect(client.getDocumentCount()).toBe(0);
    });
  });
});
