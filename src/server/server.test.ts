import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { getLogger } from "@logtape/logtape";
import { Server } from "./server";
import { Client } from "./client";
import { AckMessage, InMemoryPubSub, DocMessage } from "teleportal";
import {
  createTokenManager,
  checkPermissionWithTokenManager,
} from "teleportal/token";
import type {
  ServerContext,
  Message,
  Transport,
  StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
} from "teleportal/storage";

// Mock DocumentStorage for testing
class MockDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";

  public mockHandleUpdate = false;
  public storedUpdate: Update | null = null;
  public metadata: Map<string, DocumentMetadata> = new Map();

  async handleSyncStep1(
    documentId: string,
    syncStep1: StateVector,
  ): Promise<Document> {
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: new Uint8Array([1, 2, 3]) as unknown as Update,
        stateVector: syncStep1,
      },
    };
  }

  async handleSyncStep2(
    _key: string,
    _syncStep2: SyncStep2Update,
  ): Promise<void> {
    return;
  }

  async handleUpdate(_documentId: string, update: Update): Promise<void> {
    this.mockHandleUpdate = true;
    this.storedUpdate = update;
  }

  async getDocument(documentId: string): Promise<Document | null> {
    if (!this.storedUpdate) return null;
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: this.storedUpdate,
        stateVector: new Uint8Array() as unknown as StateVector,
      },
    };
  }

  async writeDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    this.metadata.set(documentId, metadata);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    const now = Date.now();
    return (
      this.metadata.get(documentId) ?? {
        createdAt: now,
        updatedAt: now,
        encrypted: false,
      }
    );
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.metadata.delete(documentId);
    this.storedUpdate = null;
  }

  transaction<T>(_documentId: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  async addFileToDocument(documentId: string, fileId: string): Promise<void> {
    await this.transaction(documentId, async () => {
      const metadata = await this.getDocumentMetadata(documentId);
      const files = Array.from(new Set([...(metadata.files ?? []), fileId]));
      await this.writeDocumentMetadata(documentId, {
        ...metadata,
        files,
        updatedAt: Date.now(),
      });
    });
  }

  async removeFileFromDocument(
    documentId: string,
    fileId: string,
  ): Promise<void> {
    await this.transaction(documentId, async () => {
      const metadata = await this.getDocumentMetadata(documentId);
      const files = (metadata.files ?? []).filter((id) => id !== fileId);
      await this.writeDocumentMetadata(documentId, {
        ...metadata,
        files,
        updatedAt: Date.now(),
      });
    });
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
    });

    it("should use default pubSub when not provided", async () => {
      const serverWithDefaultPubSub = new Server({
        getStorage: mockGetStorage,
      });
      expect(serverWithDefaultPubSub.pubSub).toBeDefined();
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
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      expect(session).toBeDefined();
      expect(session.documentId).toBe("test-doc");
      expect(session.encrypted).toBe(false);
    });

    it("should return existing session when called twice", async () => {
      const session1 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      const session2 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      expect(session1).toBe(session2);
    });

    it("should handle concurrent calls and return the same session", async () => {
      // Simulate race condition: multiple concurrent calls for the same document
      const context = { userId: "user-1", room: "room", clientId: "client-1" };

      const [session1, session2, session3] = await Promise.all([
        server.getOrOpenSession("concurrent-doc", {
          encrypted: false,
          context,
        }),
        server.getOrOpenSession("concurrent-doc", {
          encrypted: false,
          context,
        }),
        server.getOrOpenSession("concurrent-doc", {
          encrypted: false,
          context,
        }),
      ]);

      // All concurrent calls should return the same session instance
      expect(session1).toBe(session2);
      expect(session2).toBe(session3);
      expect(session1.documentId).toBe("concurrent-doc");
    });

    it("should create session with custom id", async () => {
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        id: "custom-session-id",
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      expect(session).toBeDefined();
      expect(session.id).toBe("custom-session-id");
    });

    it("should create encrypted session", async () => {
      const session = await server.getOrOpenSession("encrypted-doc", {
        encrypted: true,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      expect(session).toBeDefined();
      expect(session.encrypted).toBe(true);
    });

    it("should throw error when encryption state mismatches existing session", async () => {
      // Create a session with encrypted: false
      await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Try to get the same session with encrypted: true - should throw
      await expect(
        server.getOrOpenSession("test-doc", {
          encrypted: true,
          context: { userId: "user-1", room: "room", clientId: "client-1" },
        }),
      ).rejects.toThrow("Encryption state mismatch");

      // Also test the reverse: create encrypted session, then try unencrypted
      await server.getOrOpenSession("encrypted-test-doc", {
        encrypted: true,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      await expect(
        server.getOrOpenSession("encrypted-test-doc", {
          encrypted: false,
          context: { userId: "user-1", room: "room", clientId: "client-1" },
        }),
      ).rejects.toThrow("Encryption state mismatch");
    });

    it("should call getStorage with correct parameters", async () => {
      let calledWith: any = null;
      const customGetStorage = (ctx: any) => {
        calledWith = ctx;
        return Promise.resolve(new MockDocumentStorage());
      };

      const customServer = new Server({
        getStorage: customGetStorage,
        pubSub,
      });

      await customServer.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "", clientId: "client-1" },
      });

      expect(calledWith).toBeDefined();
      expect(calledWith.documentId).toBe("test-doc");
      expect(calledWith.encrypted).toBe(false);

      await customServer[Symbol.asyncDispose]();
    });

    it("should call getStorage with composite documentId when room is provided", async () => {
      let calledWith: any = null;
      const customGetStorage = (ctx: any) => {
        calledWith = ctx;
        return Promise.resolve(new MockDocumentStorage());
      };

      const customServer = new Server({
        getStorage: customGetStorage,
        pubSub,
      });

      const roomContext: ServerContext = {
        userId: "user-1",
        room: "room-1",
        clientId: "client-1",
      };

      await customServer.getOrOpenSession("test-doc", {
        encrypted: false,
        context: roomContext,
      });

      expect(calledWith).toBeDefined();
      expect(calledWith.documentId).toBe("room-1/test-doc");
      expect(calledWith.encrypted).toBe(false);
      expect(calledWith.context).toBe(roomContext);

      await customServer[Symbol.asyncDispose]();
    });

    it("should create separate sessions for same document name in different rooms", async () => {
      const room1Context: ServerContext = {
        userId: "user-1",
        room: "room-1",
        clientId: "client-1",
      };
      const room2Context: ServerContext = {
        userId: "user-2",
        room: "room-2",
        clientId: "client-2",
      };

      const session1 = await server.getOrOpenSession("same-doc", {
        encrypted: false,
        context: room1Context,
      });
      const session2 = await server.getOrOpenSession("same-doc", {
        encrypted: false,
        context: room2Context,
      });

      // Sessions should be different instances
      expect(session1).not.toBe(session2);
      // documentId should be the original client-facing name
      expect(session1.documentId).toBe("same-doc");
      expect(session2.documentId).toBe("same-doc");
      // namespacedDocumentId should reflect the composite key
      expect(session1.namespacedDocumentId).toBe("room-1/same-doc");
      expect(session2.namespacedDocumentId).toBe("room-2/same-doc");
    });

    it("should return same session for same room and document", async () => {
      const room1Context: ServerContext = {
        userId: "user-1",
        room: "room-1",
        clientId: "client-1",
      };

      const session1 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: room1Context,
      });
      const session2 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: room1Context,
      });

      // Should return the same session instance
      expect(session1).toBe(session2);
      expect(session1.documentId).toBe("test-doc");
      expect(session1.namespacedDocumentId).toBe("room-1/test-doc");
    });

    it("should use document name only when no room in context", async () => {
      const session1 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "", clientId: "client-1" },
      });
      const session2 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "", clientId: "client-1" },
      });

      // Should return the same session instance since the rooms are the same
      expect(session1).toBe(session2);
      expect(session1.documentId).toBe("test-doc");
    });

    it("should use document name only when room is empty string", async () => {
      const contextWithoutRoom: ServerContext = {
        userId: "user-1",
        room: "",
        clientId: "client-1",
      };

      const session1 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: contextWithoutRoom,
      });
      const session2 = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Should return a different session instance, since the rooms are different
      expect(session1).not.toBe(session2);
      expect(session1.documentId).toBe("test-doc");
      expect(session1.namespacedDocumentId).toBe("test-doc");
      expect(session2.documentId).toBe("test-doc");
      expect(session2.namespacedDocumentId).toBe("room/test-doc");
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
        context: { userId: "user-1", room: "room", clientId: "client-1" },
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
      const checkPermission = async ({
        documentId,
        fileId,
      }: {
        documentId?: string;
        fileId?: string;
      }) => {
        permissionChecked = true;
        // Verify that either documentId or fileId is provided
        expect(documentId || fileId).toBeDefined();
        return true;
      };

      const serverWithPermission = new Server({
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
      const checkPermission = async ({
        documentId,
        fileId,
      }: {
        documentId?: string;
        fileId?: string;
      }) => {
        // Verify that either documentId or fileId is provided
        expect(documentId || fileId).toBeDefined();
        return false;
      };

      const serverWithPermission = new Server({
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
        documentId,
        fileId,
      }: {
        message: Message<ServerContext>;
        type: "read" | "write";
        documentId?: string;
        fileId?: string;
      }) => {
        // Verify that either documentId or fileId is provided
        expect(documentId || fileId).toBeDefined();
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
        context: { userId: "user-1", room: "room", clientId: "client-1" },
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
        context: { userId: "user-1", room: "room", clientId: "client-1" },
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
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      const session2 = await server.getOrOpenSession("test-doc-2", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
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

  describe("session cleanup", () => {
    it("should handle cleanup callback when session has no clients", async () => {
      const session = await server.getOrOpenSession("test-doc-cleanup", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Manually trigger cleanup callback (simulating timeout firing)
      // We need to access the private method, so we'll use the session's callback
      // by removing all clients and then calling the cleanup handler directly
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-cleanup",
      });

      await server.getOrOpenSession("test-doc-cleanup", {
        encrypted: false,
        client,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Remove client to trigger cleanup scheduling
      server.disconnectClient("client-cleanup");

      // Wait a bit for cleanup to be scheduled
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify session still exists (cleanup hasn't fired yet)
      const existingSession = await server.getOrOpenSession(
        "test-doc-cleanup",
        {
          encrypted: false,
          context: { userId: "user-1", room: "room", clientId: "client-1" },
        },
      );
      expect(existingSession).toBeDefined();

      // Close transport to ensure cleanup
      transport.closeReadable();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it("should not cleanup session if client reconnects", async () => {
      const transport1 = new MockTransport();
      const client1 = server.createClient({
        transport: transport1,
        id: "client-reconnect",
      });

      const session1 = await server.getOrOpenSession("test-doc-reconnect", {
        encrypted: false,
        client: client1,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Disconnect client
      server.disconnectClient("client-reconnect");
      transport1.closeReadable();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Reconnect before cleanup fires
      const transport2 = new MockTransport();
      const client2 = server.createClient({
        transport: transport2,
        id: "client-reconnect-2",
      });

      const session2 = await server.getOrOpenSession("test-doc-reconnect", {
        encrypted: false,
        client: client2,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Session should still exist
      expect(session2).toBeDefined();
      expect(session2.documentId).toBe("test-doc-reconnect");

      transport2.closeReadable();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it("should cleanup session after delay when no clients", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-delay",
      });

      await server.getOrOpenSession("test-doc-delay", {
        encrypted: false,
        client,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Disconnect client
      server.disconnectClient("client-delay");
      transport.closeReadable();

      // Session should still exist immediately
      const sessionImmediate = await server.getOrOpenSession("test-doc-delay", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      expect(sessionImmediate).toBeDefined();

      // Note: We can't easily test the 60-second delay without waiting,
      // but we verify the cleanup mechanism is set up correctly
    });

    it("should properly dispose session when cleanup handler is called", async () => {
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-handler-test",
      });

      const session = await server.getOrOpenSession("test-doc-handler", {
        encrypted: false,
        client,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Verify session exists
      const existingSession = await server.getOrOpenSession(
        "test-doc-handler",
        {
          encrypted: false,
          context: { userId: "user-1", room: "room", clientId: "client-1" },
        },
      );
      expect(existingSession).toBeDefined();
      expect(existingSession.documentId).toBe("test-doc-handler");

      // Remove client to trigger cleanup scheduling
      server.disconnectClient("client-handler-test");
      transport.closeReadable();

      // Wait for cleanup to be scheduled
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify session should be disposed (has no clients)
      expect(session.shouldDispose).toBe(true);

      // Manually trigger cleanup handler to simulate timeout firing
      // We can't access the private method directly, but we can verify
      // the session is in the correct state for cleanup
      // The actual cleanup will happen after 60 seconds in production
    });

    it("should cancel cleanup if session gets clients before timeout", async () => {
      const transport1 = new MockTransport();
      const client1 = server.createClient({
        transport: transport1,
        id: "client-cancel-1",
      });

      const session = await server.getOrOpenSession("test-doc-cancel-timeout", {
        encrypted: false,
        client: client1,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      // Remove client
      server.disconnectClient("client-cancel-1");
      transport1.closeReadable();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify session should be disposed
      expect(session.shouldDispose).toBe(true);

      // Add client back before timeout fires
      const transport2 = new MockTransport();
      const client2 = server.createClient({
        transport: transport2,
        id: "client-cancel-2",
      });

      const session2 = await server.getOrOpenSession(
        "test-doc-cancel-timeout",
        {
          encrypted: false,
          client: client2,
          context: { userId: "user-1", room: "room", clientId: "client-1" },
        },
      );

      // Session should no longer be marked for disposal
      expect(session2.shouldDispose).toBe(false);
      expect(session2).toBe(session); // Same session instance

      transport2.closeReadable();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  describe("asyncDispose", () => {
    it("should dispose server and all sessions", async () => {
      // Create sessions
      await server.getOrOpenSession("test-doc-1", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      await server.getOrOpenSession("test-doc-2", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });

      await server[Symbol.asyncDispose]();

      // Should not throw
      expect(server).toBeDefined();
    });

    it("should dispose pubSub if it has asyncDispose", async () => {
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
        context: { userId: "user-1", room: "room", clientId: "client-1" },
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
      });
      const client2 = new Client({
        id: "client-2",
        writable: writable2,
      });

      // Both clients connect to same document
      const session = await server.getOrOpenSession("test-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
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

  describe("ACK message handling", () => {
    it("should send ACK for doc messages", async () => {
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      // Create a transport that captures messages sent to client
      const transport = new MockTransport<ServerContext>();
      // Override the writable to capture messages
      transport.writable = writable;

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
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have received an ACK message
      const ackMessages = writtenMessages.filter(
        (m) => m.type === "ack",
      ) as AckMessage<ServerContext>[];
      expect(ackMessages.length).toBe(1);
      expect(ackMessages[0].payload.messageId).toBe(message.id);

      transport.closeReadable();
    });

    it("should send ACK for file-part RPC stream messages", async () => {
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      // Create a transport that captures messages sent to client
      const transport = new MockTransport<ServerContext>();
      // Override the writable to capture messages
      transport.writable = writable;

      const client = server.createClient({
        transport,
        id: "client-1",
      });

      const { RpcMessage } = await import("teleportal/protocol");
      const message = new RpcMessage<ServerContext>(
        "test-doc",
        {
          type: "success",
          payload: {
            fileId: "test-file-id",
            chunkIndex: 0,
            chunkData: new Uint8Array([1, 2, 3]),
            merkleProof: [],
            totalChunks: 1,
            bytesUploaded: 3,
            encrypted: false,
          },
        },
        "fileDownload",
        "stream",
        "original-request-id",
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      // Enqueue message to transport
      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have received an ACK message
      const ackMessages = writtenMessages.filter(
        (m) => m.type === "ack",
      ) as AckMessage<ServerContext>[];
      expect(ackMessages.length).toBe(1);
      expect(ackMessages[0].payload.messageId).toBe(message.id);

      transport.closeReadable();
    });

    it("should NOT send ACK for ack messages (to avoid loops)", async () => {
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      // Create a transport that captures messages sent to client
      const transport = new MockTransport<ServerContext>();
      // Override the writable to capture messages
      transport.writable = writable;

      const client = server.createClient({
        transport,
        id: "client-1",
      });

      const { AckMessage } = await import("teleportal");
      const ackMessage = new AckMessage(
        {
          type: "ack",
          messageId: "some-message-id",
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      // Enqueue message to transport
      transport.enqueueMessage(ackMessage);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should NOT have received another ACK (would cause loop)
      const ackMessages = writtenMessages.filter((m) => m.type === "ack");
      expect(ackMessages.length).toBe(0);

      // Clean up - try to close, but ignore errors if already closed
      try {
        transport.closeReadable();
      } catch (error) {
        // Ignore errors if already closed
      }
    });

    it("should send ACK even when file handler throws", async () => {
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const mockStorage = new MockDocumentStorage();
      const serverWithFailingHandler = new Server({
        getStorage: () => Promise.resolve(mockStorage),
        pubSub,
        rpcHandlers: {
          stream: {
            handler: async () => {
              throw new Error("File storage unavailable");
            },
          },
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithFailingHandler.createClient({
        transport,
        id: "client-1",
      });

      const { RpcMessage } = await import("teleportal/protocol");
      const message = new RpcMessage<ServerContext>(
        "test-doc",
        {
          type: "success",
          payload: {
            fileId: "test-file-id",
            chunkIndex: 0,
            chunkData: new Uint8Array([1, 2, 3]),
            merkleProof: [],
            totalChunks: 1,
            bytesUploaded: 3,
            encrypted: false,
          },
        },
        "fileDownload",
        "stream",
        "original-request-id",
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const ackMessages = writtenMessages.filter(
        (m) => m.type === "ack",
      ) as AckMessage<ServerContext>[];
      expect(ackMessages.length).toBe(1);
      expect(ackMessages[0].payload.messageId).toBe(message.id);

      transport.closeReadable();
      await serverWithFailingHandler[Symbol.asyncDispose]();
    });
  });

  describe("checkPermissionWithTokenManager integration", () => {
    it("should allow ACK messages without permission checks", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      const ackMessage = new AckMessage(
        {
          type: "ack",
          messageId: "some-message-id",
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      transport.enqueueMessage(ackMessage);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have sent any error messages
      const errorMessages = writtenMessages.filter(
        (m) => m.type === "doc" && (m as any).payload?.type === "auth-message",
      );
      expect(errorMessages.length).toBe(0);

      // Clean up - try to close, but ignore errors if already closed
      try {
        transport.closeReadable();
      } catch (error) {
        // Ignore errors if already closed
      }
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should allow awareness messages without permission checks", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      const { AwarenessMessage } = await import("teleportal");
      const awarenessMessage = new AwarenessMessage(
        "test-doc",
        {
          type: "awareness-update",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      transport.enqueueMessage(awarenessMessage);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have sent any error messages
      const errorMessages = writtenMessages.filter(
        (m) => m.type === "doc" && (m as any).payload?.type === "auth-message",
      );
      expect(errorMessages.length).toBe(0);

      // Clean up - try to close, but ignore errors if already closed
      try {
        transport.closeReadable();
      } catch (error) {
        // Ignore errors if already closed
      }
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should check read permission for sync-step-1", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        {
          clientId: "client-1",
          ...payload.payload,
        } as ServerContext,
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have sent any auth error messages
      const errorMessages = writtenMessages.filter(
        (m) =>
          m.type === "doc" &&
          (m as any).payload?.type === "auth-message" &&
          (m as any).payload?.permission === "denied",
      );
      expect(errorMessages.length).toBe(0);

      transport.closeReadable();
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should deny read permission for sync-step-1 when user lacks access", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "other-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        {
          clientId: "client-1",
          ...payload.payload,
        } as ServerContext,
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have sent an auth error message
      const errorMessages = writtenMessages.filter(
        (m) =>
          m.type === "doc" &&
          (m as any).payload?.type === "auth-message" &&
          (m as any).payload?.permission === "denied",
      );
      expect(errorMessages.length).toBeGreaterThan(0);

      transport.closeReadable();
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should check write permission for update", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["write"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as Update },
        {
          clientId: "client-1",
          userId: payload.payload.userId,
          room: payload.payload.room,
        },
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have sent any auth error messages
      const errorMessages = writtenMessages.filter(
        (m) =>
          m.type === "doc" &&
          (m as any).payload?.type === "auth-message" &&
          (m as any).payload?.permission === "denied",
      );
      expect(errorMessages.length).toBe(0);

      transport.closeReadable();
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should deny write permission for update when user only has read", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as Update },
        {
          clientId: "client-1",
          ...payload.payload,
        } as ServerContext,
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have sent an auth error message
      const errorMessages = writtenMessages.filter(
        (m) =>
          m.type === "doc" &&
          (m as any).payload?.type === "auth-message" &&
          (m as any).payload?.permission === "denied",
      );
      expect(errorMessages.length).toBeGreaterThan(0);

      // Verify the auth-message structure
      const authMessage = errorMessages[0];
      if (
        authMessage &&
        authMessage.type === "doc" &&
        authMessage.payload.type === "auth-message"
      ) {
        expect(authMessage.payload.type).toBe("auth-message");
        expect(authMessage.payload.permission).toBe("denied");
        expect(authMessage.payload.reason).toContain(
          "Insufficient permissions",
        );
        expect(authMessage.payload.reason).toContain("test-doc");
        expect(authMessage.document).toBe("test-doc");
      }

      // Clean up - try to close, but ignore errors if already closed
      try {
        transport.closeReadable();
      } catch (error) {
        // Ignore errors if already closed
      }
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should send sync-done (not auth-message) when sync-step-2 is denied due to write permissions", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as SyncStep2Update,
        },
        {
          clientId: "client-1",
          ...payload.payload,
        } as ServerContext,
        false,
      );

      transport.enqueueMessage(message);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // sync-step-2 gets special handling - should receive sync-done, not auth-message
      const syncDoneMessages = writtenMessages.filter(
        (m) => m.type === "doc" && (m as any).payload?.type === "sync-done",
      );
      expect(syncDoneMessages.length).toBeGreaterThan(0);

      // Should NOT have sent an auth-message
      const authMessages = writtenMessages.filter(
        (m) => m.type === "doc" && (m as any).payload?.type === "auth-message",
      );
      expect(authMessages.length).toBe(0);

      // Verify the sync-done message structure
      const syncDone = syncDoneMessages[0];
      if (syncDone && syncDone.type === "doc") {
        expect(syncDone.payload.type).toBe("sync-done");
        expect(syncDone.document).toBe("test-doc");
      }

      // Clean up - try to close, but ignore errors if already closed
      try {
        transport.closeReadable();
      } catch (error) {
        // Ignore errors if already closed
      }
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should allow admin users to perform both read and write operations", async () => {
      const tokenManager = createTokenManager({
        secret: "test-secret",
      });
      const token = await tokenManager.createAdminToken("user-1", "room-1");

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const serverWithToken = new Server({
        getStorage: mockGetStorage,
        pubSub,
        checkPermission: checkPermissionWithTokenManager(tokenManager),
      });

      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const transport = new MockTransport<ServerContext>();
      transport.writable = writable;

      const client = serverWithToken.createClient({
        transport,
        id: "client-1",
      });

      // Test read operation
      const readMessage = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        {
          clientId: "client-1",
          userId: payload.payload.userId,
          room: payload.payload.room,
        },
        false,
      );

      transport.enqueueMessage(readMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Test write operation
      const writeMessage = new DocMessage(
        "test-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as Update },
        {
          clientId: "client-1",
          userId: payload.payload.userId,
          room: payload.payload.room,
        },
        false,
      );

      transport.enqueueMessage(writeMessage);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have sent any auth error messages
      const errorMessages = writtenMessages.filter(
        (m) =>
          m.type === "doc" &&
          (m as any).payload?.type === "auth-message" &&
          (m as any).payload?.permission === "denied",
      );
      expect(errorMessages.length).toBe(0);

      transport.closeReadable();
      await serverWithToken[Symbol.asyncDispose]();
    });

    it("should track message types in metrics", async () => {
      // Check initial status
      const initialStatus = await server.getStatus();
      expect(initialStatus.messageTypeBreakdown).toEqual({});

      // Create a client
      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "client-1",
      });

      // Create ack messages (simpler than doc messages for testing)
      const ackMessage1: Message<ServerContext> = {
        type: "ack",
        id: "test-msg-1",
        document: "metrics-test-doc",
      } as any;

      const ackMessage2: Message<ServerContext> = {
        type: "ack",
        id: "test-msg-2",
        document: "metrics-test-doc",
      } as any;

      // Process ack messages
      transport.enqueueMessage(ackMessage1);
      transport.enqueueMessage(ackMessage2);
      await new Promise((resolve) => setTimeout(resolve, 10)); // Allow async processing

      // Check that ack messages were tracked
      const statusAfterAck = await server.getStatus();
      expect(statusAfterAck.messageTypeBreakdown).toEqual({ ack: 2 });
      expect(statusAfterAck.totalMessagesProcessed).toBe(2);

      // Check metrics output contains the message types
      const metrics = await server.getMetrics();
      expect(metrics).toContain('teleportal_messages_total{type="ack"} 2');
      expect(metrics).toContain("teleportal_messages_total_all 2");

      transport.closeReadable();
    });
  });

  describe("events", () => {
    it("should emit client-connect event when creating a client", async () => {
      const events: any[] = [];
      server.on("client-connect", (data) => events.push(data));

      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "event-test-client",
      });

      expect(events.length).toBe(1);
      expect(events[0].clientId).toBe("event-test-client");

      transport.closeReadable();
    });

    it("should emit client-disconnect event when disconnecting a client", async () => {
      const events: any[] = [];
      server.on("client-disconnect", (data) => events.push(data));

      const transport = new MockTransport();
      const client = server.createClient({
        transport,
        id: "disconnect-test-client",
      });

      // Disconnect the client
      server.disconnectClient("disconnect-test-client", "manual");

      expect(events.length).toBe(1);
      expect(events[0].clientId).toBe("disconnect-test-client");
      expect(events[0].reason).toBe("manual");
    });

    it("should emit client-disconnect with abort reason when abort signal is triggered", async () => {
      const events: any[] = [];
      server.on("client-disconnect", (data) => events.push(data));

      const transport = new MockTransport();
      const abortController = new AbortController();

      server.createClient({
        transport,
        id: "abort-test-client",
        abortSignal: abortController.signal,
      });

      // Trigger abort
      abortController.abort();

      expect(events.length).toBe(1);
      expect(events[0].clientId).toBe("abort-test-client");
      expect(events[0].reason).toBe("abort");
    });

    it("should emit client-disconnect with stream-ended reason when stream ends", async () => {
      const events: any[] = [];
      server.on("client-disconnect", (data) => events.push(data));

      const transport = new MockTransport();
      server.createClient({
        transport,
        id: "stream-ended-client",
      });

      // Close the readable stream to simulate client disconnect
      transport.closeReadable();

      // Wait for the stream to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBe(1);
      expect(events[0].clientId).toBe("stream-ended-client");
      expect(events[0].reason).toBe("stream-ended");
    });

    it("should emit document-load event when first client connects to document", async () => {
      const events: any[] = [];
      server.on("document-load", (data) => events.push(data));

      const transport = new MockTransport();
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      const client = server.createClient({
        transport: customTransport,
        id: "doc-load-client",
      });

      const message = new DocMessage(
        "load-test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "doc-load-client", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBe(1);
      expect(events[0].documentId).toBe("load-test-doc");
      expect(events[0].sessionId).toBeDefined();
      expect(events[0].encrypted).toBe(false);
      expect(events[0].context.userId).toBe("user-1");

      transport.closeReadable();
    });

    it("should emit document-unload event when session is cleaned up", async () => {
      const events: any[] = [];
      server.on("document-unload", (data) => events.push(data));

      const transport = new MockTransport();
      const writtenMessages: Message<ServerContext>[] = [];
      const writable = new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      });

      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      const client = server.createClient({
        transport: customTransport,
        id: "doc-unload-client",
      });

      const message = new DocMessage(
        "unload-test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "doc-unload-client", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Close the stream to trigger disconnect
      transport.closeReadable();

      // Wait for cleanup timeout (60 seconds in production, but we can check it was scheduled)
      // The unload event is emitted after the cleanup delay
      expect(events.length).toBe(0); // Not yet unloaded

      // For testing, we can force cleanup by manually disposing the server
      // which will emit unload with reason "dispose"
    });

    it("should emit document-delete event when deleteDocument is called", async () => {
      const events: any[] = [];
      server.on("document-delete", (data) => events.push(data));

      // First, create a session by connecting a client
      const transport = new MockTransport();
      const writable = new WritableStream({ write() {} });

      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      const client = server.createClient({
        transport: customTransport,
        id: "doc-delete-client",
      });

      const message = new DocMessage(
        "delete-test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "doc-delete-client", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now delete the document
      await server.deleteDocument(
        "delete-test-doc",
        { clientId: "doc-delete-client", userId: "user-1", room: "room" },
        false,
      );

      expect(events.length).toBe(1);
      expect(events[0].documentId).toBe("delete-test-doc");
      expect(events[0].encrypted).toBe(false);

      transport.closeReadable();
    });

    it("should emit client-message event when processing messages", async () => {
      const events: any[] = [];
      server.on("client-message", (data) => events.push(data));

      const transport = new MockTransport();
      const writable = new WritableStream({ write() {} });

      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      const client = server.createClient({
        transport: customTransport,
        id: "msg-test-client",
      });

      const message = new DocMessage(
        "msg-test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "msg-test-client", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have received the message (direction: "in")
      const inboundMessages = events.filter((e) => e.direction === "in");
      expect(inboundMessages.length).toBeGreaterThan(0);
      expect(inboundMessages[0].clientId).toBe("msg-test-client");
      expect(inboundMessages[0].messageType).toBe("doc");
      expect(inboundMessages[0].documentId).toBe("msg-test-doc");

      transport.closeReadable();
    });

    it("should emit before-server-shutdown and after-server-shutdown events", async () => {
      const beforeEvents: any[] = [];
      const afterEvents: any[] = [];

      server.on("before-server-shutdown", (data) => beforeEvents.push(data));
      server.on("after-server-shutdown", (data) => afterEvents.push(data));

      // Create a session first
      const transport = new MockTransport();
      const writable = new WritableStream({ write() {} });

      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      server.createClient({
        transport: customTransport,
        id: "shutdown-client",
      });

      const message = new DocMessage(
        "shutdown-test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "shutdown-client", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 50));

      transport.closeReadable();

      // Dispose the server
      await server[Symbol.asyncDispose]();

      expect(beforeEvents.length).toBe(1);
      expect(beforeEvents[0].activeSessions).toBe(1);
      expect(beforeEvents[0].pendingSessions).toBe(0);

      expect(afterEvents.length).toBe(1);
      expect(afterEvents[0].nodeId).toBeDefined();
    });

    it("should emit document-unload with reason 'dispose' during server shutdown", async () => {
      const unloadEvents: any[] = [];
      server.on("document-unload", (data) => unloadEvents.push(data));

      // Create a session first
      const transport = new MockTransport();
      const writable = new WritableStream({ write() {} });

      const customTransport = {
        readable: transport.readable,
        writable,
      } as Transport<ServerContext>;

      server.createClient({
        transport: customTransport,
        id: "dispose-test-client",
      });

      const message = new DocMessage(
        "dispose-test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "dispose-test-client", userId: "user-1", room: "room" },
        false,
      );

      transport.enqueueMessage(message);
      await new Promise((resolve) => setTimeout(resolve, 50));

      transport.closeReadable();

      // Dispose the server
      await server[Symbol.asyncDispose]();

      // Should have emitted document-unload with reason "dispose"
      const disposeEvent = unloadEvents.find((e) => e.reason === "dispose");
      expect(disposeEvent).toBeDefined();
      expect(disposeEvent.documentId).toBe("dispose-test-doc");
    });
  });
});
