import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Server } from "./server";
import { logger } from "./logger";
import { InMemoryPubSub } from "teleportal";
import { DocumentStorage } from "teleportal/storage";
import type {
  ServerContext,
  Message,
  Transport,
  StateVector,
  SyncStep2Update,
} from "teleportal";

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

  async write(documentId: string, update: any) {
    this.mockWrite = true;
    this.storedData = update;
  }
}

// Mock Transport for testing
class MockTransport<Context extends ServerContext>
  implements Transport<Context>
{
  public readable: ReadableStream<Message<Context>>;
  public writable: WritableStream<Message<Context>>;
  public mockDestroy = false;

  constructor() {
    const { readable, writable } = new TransformStream<Message<Context>>();
    this.readable = readable;
    this.writable = writable;
  }

  async destroy() {
    this.mockDestroy = true;
  }

  // Add index signature to satisfy Record<string, unknown>
  [key: string]: unknown;
}

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

  getDocumentCount(): number {
    return this.documents.size;
  }
}

describe("Server", () => {
  let server: Server<ServerContext>;
  let mockGetStorage: any;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    mockGetStorage = () => Promise.resolve(new MockDocumentStorage());

    server = new Server({
      logger: logger.child().withContext({ name: "test" }),
      getStorage: mockGetStorage,
      pubSub,
    });
  });

  afterEach(async () => {
    await server.destroy();
  });

  describe("constructor", () => {
    it("should create a Server instance", () => {
      expect(server).toBeDefined();
      expect(server.logger).toBeDefined();
      expect(server.pubsub).toBeDefined();
    });

    it("should use default logger when not provided", () => {
      const serverWithDefaultLogger = new Server({
        getStorage: mockGetStorage,
        pubSub,
      });
      expect(serverWithDefaultLogger.logger).toBeDefined();
      serverWithDefaultLogger.destroy();
    });

    it("should use default pubsub when not provided", () => {
      const serverWithDefaultPubSub = new Server({
        getStorage: mockGetStorage,
      });
      expect(serverWithDefaultPubSub.pubsub).toBeDefined();
      serverWithDefaultPubSub.destroy();
    });
  });

  describe("getStats", () => {
    it("should return server statistics", () => {
      const stats = server.getStats();

      expect(stats).toHaveProperty("timestamp");
      expect(stats).toHaveProperty("clock");
      expect(stats).toHaveProperty("numClients");
      expect(stats).toHaveProperty("numDocuments");
      expect(stats).toHaveProperty("clientIds");
      expect(stats).toHaveProperty("documentIds");
      expect(Array.isArray(stats.clientIds)).toBe(true);
      expect(Array.isArray(stats.documentIds)).toBe(true);
    });

    it("should increment clock on each call", () => {
      const stats1 = server.getStats();
      const stats2 = server.getStats();

      expect(stats2.clock).toBe(stats1.clock + 1);
    });
  });

  describe("getDocument", () => {
    it("should return undefined for non-existing document", () => {
      const document = server.getDocument("non-existing");
      expect(document).toBeUndefined();
    });

    it("should return document for existing document", async () => {
      // Create a document first
      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      // We need to create a client first to create a document
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      const document = await server.getOrCreateDocument(message);
      const retrievedDocument = server.getDocument(document.id);

      expect(retrievedDocument).toBe(document);

      await server.disconnectClient("client-1");
    });
  });

  describe("getOrCreateDocument", () => {
    it("should throw error when client not found", async () => {
      const message = {
        document: "test-doc",
        context: { clientId: "non-existing", userId: "user-1", room: "room" },
        encrypted: false,
      };

      await expect(server.getOrCreateDocument(message)).rejects.toThrow(
        "Client not found",
      );
    });

    it("should create document and subscribe client", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const document = await server.getOrCreateDocument(message);

      expect(document).toBeDefined();
      expect(document.name).toBe("test-doc");
      expect(client.getDocumentCount()).toBe(1);

      await server.disconnectClient("client-1");
    });
  });

  describe("createClient", () => {
    it("should create a new client", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      expect(client).toBeDefined();
      expect(client.id).toBe("client-1");

      await server.disconnectClient("client-1");
    });

    it("should throw error when client already exists", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      await expect(
        server.createClient({
          transport: new MockTransport(),
          id: "client-1",
        }),
      ).rejects.toThrow("Client already exists");

      await server.disconnectClient("client-1");
    });

    it("should emit client-connected event", async () => {
      let eventEmitted = false;
      let emittedClient: any;

      server.on("client-connected", (client) => {
        eventEmitted = true;
        emittedClient = client;
      });

      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      expect(eventEmitted).toBe(true);
      expect(emittedClient).toBe(client);

      await server.disconnectClient("client-1");
    });
  });

  describe("disconnectClient", () => {
    it("should disconnect existing client", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      await server.disconnectClient("client-1");

      // Client should be removed from manager
      expect(server.getStats().numClients).toBe(0);
    });

    it("should not throw when disconnecting non-existing client", async () => {
      await expect(
        server.disconnectClient("non-existing"),
      ).resolves.toBeUndefined();
    });

    it("should emit client-disconnected event", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      let eventEmitted = false;
      let emittedClient: any;

      server.on("client-disconnected", (client) => {
        eventEmitted = true;
        emittedClient = client;
      });

      await server.disconnectClient("client-1");

      expect(eventEmitted).toBe(true);
      expect(emittedClient).toBe(client);
    });
  });

  describe("destroy", () => {
    it("should destroy server and all managers", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      await server.destroy();

      // All managers should be destroyed
      expect(server.getStats().numClients).toBe(0);
      expect(server.getStats().numDocuments).toBe(0);
    });

    it("should work with empty server", async () => {
      await expect(server.destroy()).resolves.toBeUndefined();
    });
  });

  describe("permission checking", () => {
    it("should allow all when no checkPermission function provided", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      // Should not throw when no permission check is configured
      expect(client).toBeDefined();

      await server.disconnectClient("client-1");
    });

    it("should use checkPermission function when provided", async () => {
      const checkPermission = async () => true;

      const serverWithPermission = new Server({
        logger: logger.child().withContext({ name: "test" }),
        getStorage: mockGetStorage,
        pubSub,
        checkPermission,
      });

      const transport = new MockTransport();
      const client = await serverWithPermission.createClient({
        transport,
        id: "client-1",
      });

      expect(client).toBeDefined();

      await serverWithPermission.disconnectClient("client-1");
      await serverWithPermission.destroy();
    });
  });

  describe("document lifecycle events", () => {
    it("should emit document-load event when document is created", async () => {
      let eventEmitted = false;
      let emittedDocument: any;

      server.on("document-load", (document) => {
        eventEmitted = true;
        emittedDocument = document;
      });

      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const document = await server.getOrCreateDocument(message);

      expect(eventEmitted).toBe(true);
      expect(emittedDocument).toBe(document);

      await server.disconnectClient("client-1");
    });

    it("should emit document-unload event when document is destroyed", async () => {
      const transport = new MockTransport();
      const client = await server.createClient({
        transport,
        id: "client-1",
      });

      const message = {
        document: "test-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      };

      const document = await server.getOrCreateDocument(message);

      let eventEmitted = false;
      let emittedDocument: any;

      server.on("document-unload", (document) => {
        eventEmitted = true;
        emittedDocument = document;
      });

      await document.destroy();

      expect(eventEmitted).toBe(true);
      expect(emittedDocument).toBe(document);

      await server.disconnectClient("client-1");
    });
  });
});
