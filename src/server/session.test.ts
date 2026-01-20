import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLogger } from "@logtape/logtape";
import type {
  Message,
  ServerContext,
  StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";
import { DocMessage, InMemoryPubSub } from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
} from "teleportal/storage";
import { Session } from "./session";
import { Server } from "./server";
import { Client } from "./client";

// Mock Client class for testing
class MockClient<Context extends ServerContext> {
  public id: string;
  public sentMessages: Message<Context>[] = [];
  public mockSend = false;

  constructor(id: string) {
    this.id = id;
  }

  async send(message: Message<Context>) {
    this.mockSend = true;
    this.sentMessages.push(message);
  }
}

// Mock DocumentStorage for testing
class MockDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";

  fileStorage = undefined;

  public mockGetDocument = false;
  public mockHandleUpdate = false;
  public mockHandleSyncStep2 = false;
  public storedUpdate: Update | null = null;
  public lastSyncStep2: SyncStep2Update | null = null;
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
    syncStep2: SyncStep2Update,
  ): Promise<void> {
    this.mockHandleSyncStep2 = true;
    this.lastSyncStep2 = syncStep2;
  }

  async handleUpdate(_documentId: string, update: Update): Promise<void> {
    this.mockHandleUpdate = true;
    this.storedUpdate = update;
  }

  async getDocument(documentId: string): Promise<Document | null> {
    this.mockGetDocument = true;
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
      const files = [...new Set([...(metadata.files ?? []), fileId])];
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

// Mock Server for testing
function createMockServer(): Server<ServerContext> {
  return new Server<ServerContext>({
    storage: async () => {
      throw new Error("Not implemented in mock");
    },
  });
}

describe("Session", () => {
  let session: Session<ServerContext>;
  let storage: MockDocumentStorage;
  let pubSub: InMemoryPubSub;
  let client1: MockClient<ServerContext>;
  let client2: MockClient<ServerContext>;
  let client1AsClient: Client<ServerContext>;
  let client2AsClient: Client<ServerContext>;
  const nodeId = "test-node";
  let mockServer: Server<ServerContext>;

  beforeEach(() => {
    storage = new MockDocumentStorage();
    pubSub = new InMemoryPubSub();
    client1 = new MockClient<ServerContext>("client-1");
    client2 = new MockClient<ServerContext>("client-2");
    client1AsClient = client1 as any;
    client2AsClient = client2 as any;
    mockServer = createMockServer();

    session = new Session({
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      id: "session-1",
      encrypted: false,
      storage,
      pubSub: pubSub,
      nodeId,
      onCleanupScheduled: () => {
        // No-op for tests
      },
      server: mockServer,
    });
  });

  afterEach(async () => {
    await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  describe("constructor", () => {
    it("should create a Session instance", () => {
      expect(session).toBeDefined();
      expect(session.documentId).toBe("test-doc");
      expect(session.id).toBe("session-1");
      expect(session.encrypted).toBe(false);
    });

    it("should create a Session instance with custom dedupe", () => {
      const { TtlDedupe } = require("./dedupe");
      const customDedupe = new TtlDedupe({ ttlMs: 60_000 });
      const customSession = new Session({
        documentId: "test-doc-2",
        namespacedDocumentId: "test-doc-2",
        id: "session-2",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        dedupe: customDedupe,
        onCleanupScheduled: () => {
          // No-op for tests
        },
        server: mockServer,
      });
      expect(customSession).toBeDefined();
    });
  });

  describe("load", () => {
    it("should load the session and subscribe to pubSub", async () => {
      await session.load();
      // Session should be loaded (no way to directly check, but should not throw)
      expect(session).toBeDefined();
    });

    it("should only load once", async () => {
      await session.load();
      await session.load(); // Should not throw or cause issues
      expect(session).toBeDefined();
    });

    it("should receive messages from pubSub", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const message = new DocMessage(
        "test-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as Update },
        { clientId: "other-client", userId: "user-1", room: "room" },
        false,
      );

      // Publish from different node
      await pubSub.publish(
        `document/test-doc` as const,
        message.encoded,
        "other-node",
      );

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Client should receive the broadcast
      expect(client1.sentMessages.length).toBeGreaterThan(0);
    });

    it("should ignore messages from same node", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const message = new DocMessage(
        "test-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as Update },
        { clientId: "other-client", userId: "user-1", room: "room" },
        false,
      );

      // Publish from same node
      await pubSub.publish(
        `document/test-doc` as const,
        message.encoded,
        nodeId,
      );

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Client should not receive the message (same node)
      expect(client1.sentMessages.length).toBe(0);
    });

    it("should ignore messages for different documents", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const message = new DocMessage(
        "other-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as Update },
        { clientId: "other-client", userId: "user-1", room: "room" },
        false,
      );

      // Publish message for different document
      await pubSub.publish(
        `document/other-doc` as const,
        message.encoded,
        "other-node",
      );

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Client should not receive the message (wrong document)
      expect(client1.sentMessages.length).toBe(0);
    });
  });

  describe("addClient", () => {
    it("should add a client to the session", () => {
      session.addClient(client1 as any);
      // No direct way to check clients, but should not throw
      expect(session).toBeDefined();
    });

    it("should add multiple clients", () => {
      session.addClient(client1 as any);
      session.addClient(client2 as any);
      expect(session).toBeDefined();
    });
  });

  describe("removeClient", () => {
    it("should remove a client by ID", () => {
      session.addClient(client1 as any);
      session.removeClient("client-1");
      // Should not throw
      expect(session).toBeDefined();
    });

    it("should remove a client by client object", () => {
      session.addClient(client1 as any);
      session.removeClient(client1 as any);
      // Should not throw
      expect(session).toBeDefined();
    });

    it("should not throw when removing non-existent client", () => {
      expect(() => session.removeClient("non-existent")).not.toThrow();
    });

    it("should schedule cleanup when last client is removed", () => {
      let cleanupCalled = false;
      let cleanupSession: Session<ServerContext> | null = null;
      const testSession = new Session({
        documentId: "test-doc-cleanup",
        namespacedDocumentId: "test-doc-cleanup",
        id: "session-cleanup",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: (s) => {
          cleanupCalled = true;
          cleanupSession = s;
        },
        server: mockServer,
      });

      testSession.addClient(client1 as any);
      expect(testSession.shouldDispose).toBe(false);
      testSession.removeClient("client-1");
      expect(testSession.shouldDispose).toBe(true);
      // Cleanup callback should be set up (we can't test the timeout without waiting 60s)
      // But we verify the session is in the correct state for cleanup

      // Clean up
      testSession[Symbol.asyncDispose]();
    });

    it("should cancel cleanup when client reconnects", (done: () => void) => {
      let cleanupCalled = false;
      const testSession = new Session({
        documentId: "test-doc-cancel",
        namespacedDocumentId: "test-doc-cancel",
        id: "session-cancel",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {
          cleanupCalled = true;
        },
        server: mockServer,
      });

      testSession.addClient(client1 as any);
      testSession.removeClient("client-1");
      // Immediately add client back - should cancel cleanup
      testSession.addClient(client1 as any);

      // Wait a bit to ensure cleanup doesn't fire
      setTimeout(() => {
        expect(cleanupCalled).toBe(false);
        done();
      }, 100);

      // Clean up
      setTimeout(() => {
        testSession[Symbol.asyncDispose]();
      }, 200);
    });

    it("should not schedule cleanup if clients remain", () => {
      let cleanupCalled = false;
      const testSession = new Session({
        documentId: "test-doc-multi",
        namespacedDocumentId: "test-doc-multi",
        id: "session-multi",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {
          cleanupCalled = true;
        },
        server: mockServer,
      });

      testSession.addClient(client1 as any);
      testSession.addClient(client2 as any);
      testSession.removeClient("client-1");
      // Should not schedule cleanup since client2 is still present

      expect(cleanupCalled).toBe(false);
      testSession.removeClient("client-2");
      // Now cleanup should be scheduled
      // Note: We can't easily test the timeout without waiting, but we verify
      // the behavior by checking that cleanup is only scheduled when empty
    });
  });

  describe("broadcast", () => {
    it("should broadcast message to all clients", async () => {
      session.addClient(client1 as any);
      session.addClient(client2 as any);

      const message = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await session.broadcast(message);

      expect(client1.sentMessages.length).toBe(1);
      expect(client2.sentMessages.length).toBe(1);
    });

    it("should exclude specified client from broadcast", async () => {
      session.addClient(client1 as any);
      session.addClient(client2 as any);

      const message = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await session.broadcast(message, "client-1");

      expect(client1.sentMessages.length).toBe(0);
      expect(client2.sentMessages.length).toBe(1);
    });

    it("should handle broadcast with no clients", async () => {
      const message = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await expect(session.broadcast(message)).resolves.toBeUndefined();
    });
  });

  describe("write", () => {
    it("should write update to storage", async () => {
      const update = new Uint8Array([1, 2, 3]) as Update;
      await session.write(update);

      expect(storage.mockHandleUpdate).toBe(true);
      expect(storage.storedUpdate).toBe(update);
    });
  });

  describe("apply", () => {
    it("should throw error for encryption mismatch", async () => {
      const encryptedSession = new Session({
        documentId: "encrypted-doc",
        namespacedDocumentId: "encrypted-doc",
        id: "session-encrypted",
        encrypted: true,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {},
        server: mockServer,
      });

      const message = new DocMessage(
        "encrypted-doc",
        { type: "sync-done" },
        { clientId: "client-1", userId: "user-1", room: "room" },
        false, // Not encrypted
      );

      await expect(encryptedSession.apply(message)).rejects.toThrow(
        "Message encryption and document encryption are mismatched",
      );

      await encryptedSession[Symbol.asyncDispose]();
    });

    describe("sync-step-1", () => {
      it("should handle sync-step-1 message", async () => {
        await session.load();
        session.addClient(client1 as any);

        const stateVector = new Uint8Array([1, 2, 3]) as StateVector;
        const message = new DocMessage(
          "test-doc",
          { type: "sync-step-1", sv: stateVector },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        await session.apply(message, client1 as any);

        // Should send sync-step-2 and sync-step-1 back
        expect(client1.sentMessages.length).toBe(2);
        expect(client1.sentMessages[0].payload.type).toBe("sync-step-2");
        expect(client1.sentMessages[1].payload.type).toBe("sync-step-1");
      });

      it("should not send response if no client provided", async () => {
        const stateVector = new Uint8Array([1, 2, 3]) as StateVector;
        const message = new DocMessage(
          "test-doc",
          { type: "sync-step-1", sv: stateVector },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        await session.apply(message);

        // Should not throw
        expect(session).toBeDefined();
      });
    });

    describe("update", () => {
      it("should handle update message", async () => {
        await session.load();
        session.addClient(client1 as any);
        session.addClient(client2 as any);

        const update = new Uint8Array([1, 2, 3]) as Update;
        const message = new DocMessage(
          "test-doc",
          { type: "update", update },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        await session.apply(message, client1 as any);

        // Should write to storage
        expect(storage.mockHandleUpdate).toBe(true);
        // Should broadcast to other clients
        expect(client2.sentMessages.length).toBe(1);
        // Should not send to originating client
        expect(client1.sentMessages.length).toBe(0);
      });

      it("should publish update to pubSub", async () => {
        await session.load();
        session.addClient(client1 as any);

        const update = new Uint8Array([1, 2, 3]) as Update;
        const message = new DocMessage(
          "test-doc",
          { type: "update", update },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        const testPubSub = new InMemoryPubSub();
        const testSession = new Session({
          documentId: "test-doc-2",
          namespacedDocumentId: "test-doc-2",
          id: "session-2",
          encrypted: false,
          storage,
          pubSub: testPubSub,
          nodeId,
          onCleanupScheduled: () => {
            // No-op for tests
          },
          server: mockServer,
        });

        await testSession.load();
        await testSession.apply(message, client1 as any);

        // Message should be published (we can't easily verify this without subscribing)
        await testSession[Symbol.asyncDispose]();
        await testPubSub[Symbol.asyncDispose]();
      });
    });

    describe("sync-step-2", () => {
      it("should handle sync-step-2 message", async () => {
        await session.load();
        session.addClient(client1 as any);
        session.addClient(client2 as any);

        const update = new Uint8Array([1, 2, 3]) as SyncStep2Update;
        const message = new DocMessage(
          "test-doc",
          { type: "sync-step-2", update },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        await session.apply(message, client1 as any);

        // Should broadcast to other clients
        expect(client2.sentMessages.length).toBe(1);
        // Should handle sync-step-2 in storage
        expect(storage.mockHandleSyncStep2).toBe(true);
        // Should send sync-done to originating client
        expect(client1.sentMessages.length).toBe(1);
        expect(client1.sentMessages[0].payload.type).toBe("sync-done");
      });

      it("should not send sync-done if no client provided", async () => {
        const update = new Uint8Array([1, 2, 3]) as SyncStep2Update;
        const message = new DocMessage(
          "test-doc",
          { type: "sync-step-2", update },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        await session.apply(message);

        // Should not throw
        expect(session).toBeDefined();
      });
    });

    describe("sync-done and auth-message", () => {
      it("should handle sync-done message", async () => {
        const message = new DocMessage(
          "test-doc",
          { type: "sync-done" },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        await expect(session.apply(message)).resolves.toBeUndefined();
      });

      it("should handle auth-message", async () => {
        const message = new DocMessage(
          "test-doc",
          { type: "auth-message", permission: "denied", reason: "test" },
          { clientId: "client-1", userId: "user-1", room: "room" },
          false,
        );

        await expect(session.apply(message)).resolves.toBeUndefined();
      });
    });

    describe("awareness messages", () => {
      it("should broadcast awareness messages", async () => {
        session.addClient(client1 as any);
        session.addClient(client2 as any);

        const { AwarenessMessage } = require("teleportal");
        const message = new AwarenessMessage(
          "test-doc",
          {
            type: "awareness-update",
            update: new Uint8Array([1, 2, 3]),
          },
          { clientId: "client-1", userId: "user-1", room: "room" },
        );

        await session.apply(message, client1 as any);

        // Should broadcast to other clients
        expect(client2.sentMessages.length).toBe(1);
        // Should not send to originating client
        expect(client1.sentMessages.length).toBe(0);
      });
    });

    describe("unknown payload types", () => {
      it("should handle unknown doc payload types gracefully", async () => {
        const message = {
          type: "doc" as const,
          document: "test-doc",
          payload: { type: "unknown-type" },
          context: { clientId: "client-1", userId: "user-1", room: "room" },
          encrypted: false,
          id: "test-id",
          encoded: new Uint8Array(),
        } as any;

        await expect(session.apply(message)).resolves.toBeUndefined();
      });
    });
  });

  describe("asyncDispose", () => {
    it("should dispose session and unsubscribe from pubSub", async () => {
      await session.load();
      await session[Symbol.asyncDispose]();
      // Should not throw
      expect(session).toBeDefined();
    });

    it("should work when not loaded", async () => {
      const unloadedSession = new Session({
        documentId: "test-doc-3",
        namespacedDocumentId: "test-doc-3",
        id: "session-3",
        encrypted: false,
        storage,
        pubSub: pubSub,
        nodeId,
        onCleanupScheduled: () => {
          // No-op for tests
        },
        server: mockServer,
      });

      await expect(
        unloadedSession[Symbol.asyncDispose](),
      ).resolves.toBeUndefined();
    });

    it("should cancel pending cleanup when disposed", (done: () => void) => {
      let cleanupCalled = false;
      const testSession = new Session({
        documentId: "test-doc-dispose-cancel",
        namespacedDocumentId: "test-doc-dispose-cancel",
        id: "session-dispose-cancel",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {
          cleanupCalled = true;
        },
        server: mockServer,
      });

      testSession.addClient(client1 as any);
      testSession.removeClient("client-1");
      // Cleanup should be scheduled

      // Immediately dispose - should cancel cleanup
      testSession[Symbol.asyncDispose]().then(() => {
        // Wait a bit to ensure cleanup doesn't fire
        setTimeout(() => {
          expect(cleanupCalled).toBe(false);
          done();
        }, 100);
      });
    });
  });

  describe("events", () => {
    let session: Session<ServerContext>;
    let cleanupScheduled = false;
    const onCleanupScheduled = () => {
      cleanupScheduled = true;
    };

    beforeEach(async () => {
      cleanupScheduled = false;
      const storage = new MockDocumentStorage();
      const pubSub = new InMemoryPubSub();

      session = new Session({
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        id: "session-1",
        encrypted: false,
        storage,
        pubSub,
        nodeId: "node-1",
        onCleanupScheduled,
        server: mockServer,
      });

      await session.load();
    });

    afterEach(async () => {
      await session[Symbol.asyncDispose]();
    });

    it("should emit client-join event when a client is added", async () => {
      const events: any[] = [];
      session.on("client-join", (data) => events.push(data));

      const client = new MockClient<ServerContext>("client-1");
      session.addClient(client as any);

      expect(events.length).toBe(1);
      expect(events[0].clientId).toBe("client-1");
      expect(events[0].documentId).toBe("test-doc");
      expect(events[0].sessionId).toBe("session-1");
    });

    it("should not emit client-join when re-adding same client", async () => {
      const events: any[] = [];
      session.on("client-join", (data) => events.push(data));

      const client = new MockClient<ServerContext>("client-1");
      session.addClient(client as any);
      session.addClient(client as any); // Re-add same client

      expect(events.length).toBe(1); // Only one event
    });

    it("should emit client-leave event when a client is removed", async () => {
      const events: any[] = [];
      session.on("client-leave", (data) => events.push(data));

      const client = new MockClient<ServerContext>("client-1");
      session.addClient(client as any);
      session.removeClient(client as any);

      expect(events.length).toBe(1);
      expect(events[0].clientId).toBe("client-1");
      expect(events[0].documentId).toBe("test-doc");
      expect(events[0].sessionId).toBe("session-1");
    });

    it("should emit document-message event when update message is applied", async () => {
      const events: any[] = [];
      session.on("document-message", (data) => events.push(data));

      const client = new MockClient<ServerContext>("client-1");
      session.addClient(client as any);

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as SyncStep2Update,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client as any);

      const docMsgEvents = events.filter((e) => e.messageType === "doc");
      expect(docMsgEvents.length).toBeGreaterThan(0);
      expect(docMsgEvents[0].documentId).toBe("test-doc");
      expect(docMsgEvents[0].source).toBe("client");
      expect(docMsgEvents[0].clientId).toBe("client-1");
    });

    it("should emit document-message with source 'replication' for replicated messages", async () => {
      const events: any[] = [];
      session.on("document-message", (data) => events.push(data));

      const client = new MockClient<ServerContext>("client-1");
      session.addClient(client as any);

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as SyncStep2Update,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      // Call apply with replication meta to simulate replicated message
      await session.apply(message, undefined, {
        sourceNodeId: "node-2",
        deduped: false,
      });

      const replEvents = events.filter(
        (e) => e.source === "replication" && e.deduped === false,
      );
      expect(replEvents.length).toBeGreaterThan(0);
      expect(replEvents[0].sourceNodeId).toBe("node-2");
    });

    it("should emit document-message with deduped: true for deduped replication", async () => {
      const events: any[] = [];
      session.on("document-message", (data) => events.push(data));

      const client = new MockClient<ServerContext>("client-1");
      session.addClient(client as any);

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as SyncStep2Update,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      // Apply message with deduped: true
      await session.apply(message, undefined, {
        sourceNodeId: "node-2",
        deduped: true,
      });

      const dedupedEvents = events.filter((e) => e.deduped === true);
      expect(dedupedEvents.length).toBeGreaterThan(0);
    });

    it("should emit multiple document-message events for different message types", async () => {
      const events: any[] = [];
      session.on("document-message", (data) => events.push(data));

      const client = new MockClient<ServerContext>("client-1");
      session.addClient(client as any);

      // Send sync-step-2 (update)
      const updateMessage = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as SyncStep2Update,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );
      await session.apply(updateMessage, client as any);

      // Send awareness message (non-doc type)
      const awarenessMessage = {
        type: "awareness" as const,
        id: "awareness-1",
        document: "test-doc",
        encoded: new Uint8Array([1, 2, 3]),
        context: { clientId: "client-1", userId: "user-1", room: "room" },
        encrypted: false,
      } as Message<ServerContext>;
      await session.apply(awarenessMessage, client as any);

      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });
});
