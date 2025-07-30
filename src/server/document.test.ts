import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Document } from "./document";
import { logger } from "./logger";
import { DocMessage, InMemoryPubSub } from "teleportal";
import type {
  ServerContext,
  Message,
  Update,
  StateVector,
  SyncStep2Update,
} from "teleportal";
import { DocumentStorage } from "teleportal/storage";

// Mock Client class for testing
class MockClient<Context extends ServerContext> {
  public id: string;
  public documents = new Set<any>();
  public mockSend = false;
  public mockDestroy = false;

  constructor(id: string) {
    this.id = id;
  }

  async send(message: Message<Context>) {
    this.mockSend = true;
  }

  async destroy() {
    this.mockDestroy = true;
  }

  subscribeToDocument(document: any) {
    this.documents.add(document);
  }

  unsubscribeFromDocument(document: any) {
    this.documents.delete(document);
  }
}

// Mock DocumentStorage for testing
class MockDocumentStorage extends DocumentStorage {
  handleSyncStep1(
    key: string,
    syncStep1: StateVector,
  ): Promise<{ update: SyncStep2Update; stateVector: StateVector }> {
    return Promise.resolve({
      update: new Uint8Array() as SyncStep2Update,
      stateVector: syncStep1,
    });
  }
  handleSyncStep2(key: string, syncStep2: SyncStep2Update): Promise<void> {
    return Promise.resolve();
  }
  public encrypted = false;
  public mockFetch = false;
  public mockWrite = false;
  public storedData: any = null;

  async fetch(documentId: string) {
    this.mockFetch = true;
    return this.storedData;
  }

  async write(documentId: string, update: Update) {
    this.mockWrite = true;
    this.storedData = update;
  }
}

describe("Document", () => {
  let document: Document<ServerContext>;
  let storage: MockDocumentStorage;
  let pubSub: InMemoryPubSub;
  let client1: MockClient<ServerContext>;
  let client2: MockClient<ServerContext>;

  beforeEach(() => {
    storage = new MockDocumentStorage();
    pubSub = new InMemoryPubSub();
    client1 = new MockClient<ServerContext>("client-1");
    client2 = new MockClient<ServerContext>("client-2");

    document = new Document({
      name: "test-doc",
      id: "room/test-doc",
      logger: logger.child().withContext({ name: "test" }),
      storage,
      pubSub,
    });
  });

  afterEach(async () => {
    await document.destroy();
  });

  describe("constructor", () => {
    it("should create a Document instance", () => {
      expect(document).toBeDefined();
      expect(document.id).toBe("room/test-doc");
      expect(document.name).toBe("test-doc");
      expect(document.clients.size).toBe(0);
    });
  });

  describe("getRoom", () => {
    it("should extract room from document ID with slash", () => {
      expect(document.getRoom()).toBe("room");
    });

    it("should return empty string for document ID without slash", () => {
      const doc = new Document({
        name: "test-doc",
        id: "test-doc",
        logger: logger.child().withContext({ name: "test" }),
        storage,
        pubSub,
      });
      expect(doc.getRoom()).toBe("");
    });
  });

  describe("encrypted", () => {
    it("should return encryption status from storage", () => {
      expect(document.encrypted).toBe(false);

      storage.encrypted = true;
      expect(document.encrypted).toBe(true);
    });
  });

  describe("fetch", () => {
    it("should fetch data from storage", async () => {
      const testUpdate = new Uint8Array([1, 2, 3]) as Update;
      const testStateVector = new Uint8Array([4, 5, 6]) as StateVector;
      storage.storedData = { update: testUpdate, stateVector: testStateVector };

      const result = await document.fetch();

      expect(storage.mockFetch).toBe(true);
      expect(result).toEqual({
        update: testUpdate,
        stateVector: testStateVector,
      });
    });
  });

  describe("write", () => {
    it("should write data to storage", async () => {
      const testUpdate = new Uint8Array([1, 2, 3]) as Update;

      await document.write(testUpdate);

      expect(storage.mockWrite).toBe(true);
      expect(storage.storedData).toBe(testUpdate);
    });
  });

  describe("addClient", () => {
    it("should add a client to the document", () => {
      document.addClient(client1 as any);

      expect(document.clients.has(client1 as any)).toBe(true);
      expect(document.getClientCount()).toBe(1);
    });

    it("should emit client-connected event", async () => {
      let eventEmitted = false;
      let emittedClient: MockClient<ServerContext> | undefined;

      document.on("client-connected", (client: any) => {
        eventEmitted = true;
        emittedClient = client;
      });

      document.addClient(client1 as any);

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedClient).toBe(client1);
    });
  });

  describe("removeClient", () => {
    it("should remove a client from the document", () => {
      document.addClient(client1 as any);
      expect(document.getClientCount()).toBe(1);

      document.removeClient(client1 as any);

      expect(document.clients.has(client1 as any)).toBe(false);
      expect(document.getClientCount()).toBe(0);
    });

    it("should emit client-disconnected event", async () => {
      let eventEmitted = false;
      let emittedClient: MockClient<ServerContext> | undefined;

      document.on("client-disconnected", (client: any) => {
        eventEmitted = true;
        emittedClient = client;
      });

      document.addClient(client1 as any);
      document.removeClient(client1 as any);

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedClient).toBe(client1);
    });
  });

  describe("hasClient", () => {
    it("should return true for existing client", () => {
      document.addClient(client1 as any);
      expect(document.hasClient("client-1")).toBe(true);
    });

    it("should return false for non-existing client", () => {
      expect(document.hasClient("non-existing")).toBe(false);
    });
  });

  describe("getClient", () => {
    it("should return client for existing client ID", () => {
      document.addClient(client1 as any);
      const foundClient = document.getClient("client-1");
      expect(foundClient).toBe(client1 as any);
    });

    it("should return undefined for non-existing client ID", () => {
      const foundClient = document.getClient("non-existing");
      expect(foundClient).toBeUndefined();
    });
  });

  describe("getClientIds", () => {
    it("should return array of client IDs", () => {
      document.addClient(client1 as any);
      document.addClient(client2 as any);

      const clientIds = document.getClientIds();
      expect(clientIds).toContain("client-1");
      expect(clientIds).toContain("client-2");
      expect(clientIds.length).toBe(2);
    });

    it("should return empty array when no clients", () => {
      const clientIds = document.getClientIds();
      expect(clientIds).toEqual([]);
    });
  });

  describe("getClientCount", () => {
    it("should return correct client count", () => {
      expect(document.getClientCount()).toBe(0);

      document.addClient(client1 as any);
      expect(document.getClientCount()).toBe(1);

      document.addClient(client2 as any);
      expect(document.getClientCount()).toBe(2);

      document.removeClient(client1 as any);
      expect(document.getClientCount()).toBe(1);
    });
  });

  describe("static getDocumentId", () => {
    it("should return document ID with room", () => {
      const message = {
        document: "test-doc",
        context: { room: "room", clientId: "client-1", userId: "user-1" },
      };

      const documentId = Document.getDocumentId(message);
      expect(documentId).toBe("room/test-doc");
    });

    it("should return document ID without room", () => {
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "" },
      };

      const documentId = Document.getDocumentId(message);
      expect(documentId).toBe("test-doc");
    });
  });

  describe("broadcast", () => {
    it("should broadcast message to all clients except excluded one", async () => {
      document.addClient(client1 as any);
      document.addClient(client2 as any);

      const message = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await document.broadcast(message, "client-1");

      // client1 should not receive the message (excluded)
      expect(client1.mockSend).toBe(false);
      // client2 should receive the message
      expect(client2.mockSend).toBe(true);
    });

    it("should throw error for wrong document", async () => {
      const message = new DocMessage(
        "wrong-doc",
        { type: "sync-done" },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await expect(document.broadcast(message)).rejects.toThrow(
        "Received message for wrong document",
      );
    });

    it("should emit broadcast event", async () => {
      let eventEmitted = false;
      let emittedMessage: Message<ServerContext> | undefined;

      document.on("broadcast", (message: Message<ServerContext>) => {
        eventEmitted = true;
        emittedMessage = message;
      });

      const testMessage = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await document.broadcast(testMessage);

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedMessage).toBe(testMessage);
    });
  });

  describe("destroy", () => {
    it("should emit destroy event", async () => {
      let eventEmitted = false;
      let emittedDocument: Document<ServerContext> | undefined;

      document.on("destroy", (doc: Document<ServerContext>) => {
        eventEmitted = true;
        emittedDocument = doc;
      });

      await document.destroy();

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedDocument).toBe(document);
    });
  });
});
