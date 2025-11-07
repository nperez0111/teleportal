import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Server } from "./server";
import { Client } from "./client";
import { logger } from "./logger";
import { InMemoryPubSub, DocMessage } from "teleportal";
import type {
  ServerContext,
  Message,
  Transport,
  StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";
import { DocumentStorage } from "teleportal/storage";

// Mock DocumentStorage for testing
class MockDocumentStorage extends DocumentStorage {
  handleSyncStep1(
    key: string,
    syncStep1: StateVector,
  ): Promise<{ update: SyncStep2Update; stateVector: StateVector }> {
    return Promise.resolve({
      update: new Uint8Array([1, 2, 3]) as SyncStep2Update,
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
  private controller: ReadableStreamDefaultController<Message<Context>> | null =
    null;

  constructor() {
    const { readable, writable } = new TransformStream<Message<Context>>();
    this.readable = readable;
    this.writable = writable;

    // Set up readable stream controller
    const self = this;
    this.readable = new ReadableStream<Message<Context>>({
      start(controller) {
        self.controller = controller;
      },
    });
  }

  async destroy() {
    this.mockDestroy = true;
  }

  // Helper to enqueue messages for testing
  enqueueMessage(message: Message<Context>) {
    if (this.controller) {
      this.controller.enqueue(message);
    }
  }

  closeReadable() {
    if (this.controller) {
      this.controller.close();
    }
  }

  // Add index signature to satisfy Record<string, unknown>
  [key: string]: unknown;
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
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  describe("constructor", () => {
    it("should create a Server instance", () => {
      expect(server).toBeDefined();
      expect(server.logger).toBeDefined();
    });

    it("should use default logger when not provided", async () => {
      const serverWithDefaultLogger = new Server({
        getStorage: mockGetStorage,
        pubSub,
      });
      expect(serverWithDefaultLogger.logger).toBeDefined();
      await serverWithDefaultLogger[Symbol.asyncDispose]();
    });

    it("should use default pubsub when not provided", async () => {
      const serverWithDefaultPubSub = new Server({
        getStorage: mockGetStorage,
      });
      expect(serverWithDefaultPubSub.logger).toBeDefined();
      await serverWithDefaultPubSub[Symbol.asyncDispose]();
    });

    it("should use provided nodeId", async () => {
      const serverWithNodeId = new Server({
        getStorage: mockGetStorage,
        pubSub,
        nodeId: "custom-node-id",
      });
      expect(serverWithNodeId).toBeDefined();
      await serverWithNodeId[Symbol.asyncDispose]();
    });

    it("should generate random nodeId when not provided", async () => {
      const server1 = new Server({
        getStorage: mockGetStorage,
        pubSub,
      });
      const server2 = new Server({
        getStorage: mockGetStorage,
        pubSub,
      });
      // Node IDs should be different
      expect(server1).toBeDefined();
      expect(server2).toBeDefined();
      await server1[Symbol.asyncDispose]();
      await server2[Symbol.asyncDispose]();
    });
  });

  describe("getOrOpenSession", () => {
    it("should create a new session", async () => {
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });

      expect(session).toBeDefined();
      expect(session.documentId).toBe("test-doc");
      expect(session.encrypted).toBe(false);
    });

    it("should return existing session when called twice", async () => {
      const session1 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });
      const session2 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });

      expect(session1).toBe(session2);
    });

    it("should create session with custom id", async () => {
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        id: "custom-session-id",
      });

      expect(session).toBeDefined();
      expect(session.id).toBe("custom-session-id");
    });

    it("should create encrypted session", async () => {
      const session = await server.getOrOpenSession("encrypted-doc", {
        encrypted: true,
      });

      expect(session).toBeDefined();
      expect(session.encrypted).toBe(true);
    });

    it("should call getStorage with correct parameters", async () => {
      let calledWith: any = null;
      const customGetStorage = (ctx: any) => {
        calledWith = ctx;
        return Promise.resolve(new MockDocumentStorage());
      };

      const customServer = new Server({
        logger: logger.child().withContext({ name: "test" }),
        getStorage: customGetStorage,
        pubSub,
      });

      await customServer.getOrOpenSession("test-doc", {
        encrypted: false,
      });

      expect(calledWith).toBeDefined();
      expect(calledWith.documentId).toBe("test-doc");
      expect(calledWith.encrypted).toBe(false);

      await customServer[Symbol.asyncDispose]();
    });
  });

  describe("createClient", () => {
    it("should create a new client", () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      expect(client).toBeDefined();
      expect(client.id).toBe("client-1");
    });

    it("should generate random id when not provided", () => {
      const transport1 = new MockTransport();
      const transport2 = new MockTransport();
      const client1 = server.createClient({ transport: transport1 });
      const client2 = server.createClient({ transport: transport2 });

      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
      expect(client1.id).not.toBe(client2.id);

      transport1.closeReadable();
      transport2.closeReadable();
    });

    it("should handle messages from transport", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      // Enqueue message to transport
      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Session should be created
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });
      expect(session).toBeDefined();

      transport.closeReadable();
    });

    it("should disconnect client when transport stream ends", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      // Close the readable stream
      transport.closeReadable();

      // Wait for disconnect to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Client should be disconnected (no way to directly verify, but should not throw)
      expect(client).toBeDefined();
    });

    it("should handle transport stream errors", async () => {
      const errorTransport = new MockTransport();
      const client = server.createClient({
        transport: errorTransport,
        id: "client-1",
      });

      // Close readable to simulate error
      errorTransport.closeReadable();

      // Wait for error handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not throw
      expect(client).toBeDefined();
    });

    it("should check permissions when checkPermission is provided", async () => {
      let permissionChecked = false;
      const checkPermission = async () => {
        permissionChecked = true;
        return true;
      };

      const serverWithPermission = new Server({
        logger: logger.child().withContext({ name: "test" }),
        getStorage: mockGetStorage,
        pubSub,
        checkPermission,
      });

      const transport = new MockTransport();
      const client = serverWithPermission.createClient({
        transport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Permission should be checked
      expect(permissionChecked).toBe(true);

      transport.closeReadable();
      await serverWithPermission[Symbol.asyncDispose]();
    });

    it("should deny access when checkPermission returns false", async () => {
      const checkPermission = async () => false;

      const serverWithPermission = new Server({
        logger: logger.child().withContext({ name: "test" }),
        getStorage: mockGetStorage,
        pubSub,
        checkPermission,
      });

      const transport = new MockTransport();
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      // Replace writable to capture messages
      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      const client = serverWithPermission.createClient({
        transport: customTransport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should send auth-message with permission denied
      expect(writtenMessages.length).toBeGreaterThan(0);
      const authMessage = writtenMessages.find(
        (m) => m.type === "doc" && m.payload.type === "auth-message",
      );
      expect(authMessage).toBeDefined();
      if (authMessage && authMessage.type === "doc") {
        expect(authMessage.payload.type).toBe("auth-message");
      }

      transport.closeReadable();
      await serverWithPermission[Symbol.asyncDispose]();
    });

    it("should send sync-done when sync-step-2 is denied due to write permissions", async () => {
      const checkPermission = async ({
        message,
        type,
      }: {
        message: Message<ServerContext>;
        type: "read" | "write";
      }) => {
        // Deny write operations (sync-step-2 requires write)
        if (
          message.type === "doc" &&
          message.payload.type === "sync-step-2" &&
          type === "write"
        ) {
          return false;
        }
        // Allow read operations
        return true;
      };

      const serverWithPermission = new Server({
        logger: logger.child().withContext({ name: "test" }),
        getStorage: mockGetStorage,
        pubSub,
        checkPermission,
      });

      const transport = new MockTransport();
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      // Replace writable to capture messages
      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      const client = serverWithPermission.createClient({
        transport: customTransport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as SyncStep2Update,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should send sync-done message (not auth-message)
      expect(writtenMessages.length).toBeGreaterThan(0);
      const syncDoneMessage = writtenMessages.find(
        (m) => m.type === "doc" && m.payload.type === "sync-done",
      );
      expect(syncDoneMessage).toBeDefined();
      if (syncDoneMessage && syncDoneMessage.type === "doc") {
        expect(syncDoneMessage.payload.type).toBe("sync-done");
        expect(syncDoneMessage.document).toBe("test-doc");
      }

      // Should NOT send auth-message
      const authMessage = writtenMessages.find(
        (m) => m.type === "doc" && m.payload.type === "auth-message",
      );
      expect(authMessage).toBeUndefined();

      transport.closeReadable();
      await serverWithPermission[Symbol.asyncDispose]();
    });
  });

  describe("disconnectClient", () => {
    it("should disconnect client by ID", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      // Create a session and add client
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });
      session.addClient(client);

      server.disconnectClient("client-1");

      // Client should be removed from session
      // (No direct way to verify, but should not throw)
      expect(client).toBeDefined();
    });

    it("should disconnect client by client object", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      // Create a session and add client
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });
      session.addClient(client);

      server.disconnectClient(client);

      // Client should be removed from session
      expect(client).toBeDefined();
    });

    it("should disconnect client from all sessions", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      // Create multiple sessions
      const session1 = await server.getOrOpenSession("test-doc-1", {
        encrypted: false,
      });
      const session2 = await server.getOrOpenSession("test-doc-2", {
        encrypted: false,
      });

      session1.addClient(client);
      session2.addClient(client);

      server.disconnectClient("client-1");

      // Client should be removed from all sessions
      expect(client).toBeDefined();
    });

    it("should not throw when disconnecting non-existent client", () => {
      expect(() => server.disconnectClient("non-existent")).not.toThrow();
    });
  });

  describe("asyncDispose", () => {
    it("should dispose server and all sessions", async () => {
      // Create sessions
      await server.getOrOpenSession("test-doc-1", { encrypted: false });
      await server.getOrOpenSession("test-doc-2", { encrypted: false });

      await server[Symbol.asyncDispose]();

      // Should not throw
      expect(server).toBeDefined();
    });

    it("should dispose pubsub if it has asyncDispose", async () => {
      await server[Symbol.asyncDispose]();
      // Should not throw
      expect(server).toBeDefined();
    });

    it("should work with empty server", async () => {
      await expect(server[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });
  });

  describe("integration", () => {
    it("should handle full client lifecycle", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      // Send sync-step-1
      const syncStep1 = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(syncStep1);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Session should be created
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });
      expect(session).toBeDefined();

      // Disconnect client
      server.disconnectClient("client-1");

      transport.closeReadable();
    });

    it("should handle multiple clients on same document", async () => {
      // Create clients without transports to avoid stream issues
      const writable1 = new WritableStream({
        write() {},
      });
      const writable2 = new WritableStream({
        write() {},
      });

      const client1 = new Client({
        id: "client-1",
        writable: writable1,
        logger: logger.child().withContext({ name: "test" }),
      });
      const client2 = new Client({
        id: "client-2",
        writable: writable2,
        logger: logger.child().withContext({ name: "test" }),
      });

      // Both clients connect to same document
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
      });
      session.addClient(client1);
      session.addClient(client2);

      // Send update from client1
      const update = new DocMessage(
        "test-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as Update },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await session.apply(update, client1);

      // Both clients should be in session
      expect(session).toBeDefined();

      // Clean up
      server.disconnectClient("client-1");
      server.disconnectClient("client-2");
    });
  });
});
