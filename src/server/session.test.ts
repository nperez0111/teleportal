import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import type {
  Message,
  ServerContext,
  StateVector,
  Update,
  VersionedUpdate,
  VersionedSyncStep2Update,
} from "teleportal";
import { DocMessage, InMemoryPubSub } from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
  EncodedContentMap,
} from "teleportal/storage";
import type { EncryptedBinary } from "teleportal/encryption-key";
import {
  encodeContentEncryptedPayload,
  stripContent,
  encodeSidecar,
} from "teleportal/protocol/encryption";
import { decodeContentMap } from "teleportal/attribution";
import { MemoryDocumentStorage } from "../storage/in-memory/document-storage";
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

  destroy() {
    // No-op for tests
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
  public storedUpdate: VersionedUpdate | null = null;
  public storedAttribution: EncodedContentMap | null = null;
  public lastSyncStep2: VersionedSyncStep2Update | null = null;
  public metadata: Map<string, DocumentMetadata> = new Map();

  async handleSyncStep1(documentId: string, syncStep1: StateVector): Promise<Document> {
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: createTestUpdate("sync").data as Update,
        stateVector: syncStep1,
      },
    };
  }

  async handleSyncStep2(_key: string, syncStep2: VersionedSyncStep2Update): Promise<void> {
    this.mockHandleSyncStep2 = true;
    this.lastSyncStep2 = syncStep2;
  }

  async handleUpdate(
    _documentId: string,
    update: VersionedUpdate,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    this.mockHandleUpdate = true;
    this.storedUpdate = update;
    if (attribution) this.storedAttribution = attribution;
  }

  async retrieveAttribution(_documentId: string): Promise<EncodedContentMap | null> {
    return this.storedAttribution;
  }

  async getDocument(documentId: string): Promise<Document | null> {
    this.mockGetDocument = true;
    if (!this.storedUpdate) return null;
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: this.storedUpdate.data as Update,
        stateVector: new Uint8Array() as unknown as StateVector,
      },
    };
  }

  async writeDocumentMetadata(documentId: string, metadata: DocumentMetadata): Promise<void> {
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

  async removeFileFromDocument(documentId: string, fileId: string): Promise<void> {
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

function createTestUpdate(content = "test"): VersionedUpdate {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const v2 = Y.encodeStateAsUpdateV2(doc);
  const payload = encodeContentEncryptedPayload({
    structureUpdate: v2,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload } as unknown as VersionedUpdate;
}

describe("Session", () => {
  let session: Session<ServerContext>;
  let storage: MockDocumentStorage;
  let pubSub: InMemoryPubSub;
  let client1: MockClient<ServerContext>;
  let client2: MockClient<ServerContext>;
  let client1AsClient: Client<ServerContext>;
  let _client2AsClient: Client<ServerContext>;
  const nodeId = "test-node";
  let mockServer: Server<ServerContext>;

  beforeEach(() => {
    storage = new MockDocumentStorage();
    pubSub = new InMemoryPubSub();
    client1 = new MockClient<ServerContext>("client-1");
    client2 = new MockClient<ServerContext>("client-2");
    client1AsClient = client1 as any;
    _client2AsClient = client2 as any;
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
        { type: "update", update: createTestUpdate() },
        { clientId: "other-client", userId: "user-1", room: "room" },
        false,
      );

      // Publish from different node
      await pubSub.publish(`document/test-doc` as const, message.encoded, "other-node");

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 1));

      // Client should receive the broadcast
      expect(client1.sentMessages.length).toBeGreaterThan(0);
    });

    it("should ignore messages from same node", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const message = new DocMessage(
        "test-doc",
        { type: "update", update: createTestUpdate() },
        { clientId: "other-client", userId: "user-1", room: "room" },
        false,
      );

      // Publish from same node
      await pubSub.publish(`document/test-doc` as const, message.encoded, nodeId);

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 1));

      // Client should not receive the message (same node)
      expect(client1.sentMessages.length).toBe(0);
    });

    it("should ignore messages for different documents", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const message = new DocMessage(
        "other-doc",
        { type: "update", update: createTestUpdate() },
        { clientId: "other-client", userId: "user-1", room: "room" },
        false,
      );

      // Publish message for different document
      await pubSub.publish(`document/other-doc` as const, message.encoded, "other-node");

      // Wait for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 1));

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
      let _cleanupCalled = false;
      let _cleanupSession: Session<ServerContext> | null = null;
      const testSession = new Session({
        documentId: "test-doc-cleanup",
        namespacedDocumentId: "test-doc-cleanup",
        id: "session-cleanup",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: (s) => {
          _cleanupCalled = true;
          _cleanupSession = s;
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

      // Wait a bit to ensure cleanup doesn't fire (cleanup delay is 60s, so 10ms is safe)
      setTimeout(() => {
        expect(cleanupCalled).toBe(false);
        testSession[Symbol.asyncDispose]();
        done();
      }, 10);
    });

    it("should invoke onCleanupScheduled after the cleanup delay elapses", async () => {
      let cleanupSession: Session<ServerContext> | undefined;
      const testSession = new Session({
        documentId: "test-doc-fires",
        namespacedDocumentId: "test-doc-fires",
        id: "session-fires",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: (s) => {
          cleanupSession = s;
        },
        server: mockServer,
        cleanupDelayMs: 1,
      });

      testSession.addClient(client1 as any);
      testSession.removeClient("client-1");

      // Event-driven wait: poll until the scheduled cleanup actually fires.
      const start = Date.now();
      while (cleanupSession === undefined && Date.now() - start < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      expect(cleanupSession).toBe(testSession);
      await testSession[Symbol.asyncDispose]();
    });

    it("should not fire cleanup after the delay if a client reconnects within it", async () => {
      let cleanupCalled = false;
      const testSession = new Session({
        documentId: "test-doc-reconnect-window",
        namespacedDocumentId: "test-doc-reconnect-window",
        id: "session-reconnect-window",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {
          cleanupCalled = true;
        },
        server: mockServer,
        cleanupDelayMs: 1,
      });

      testSession.addClient(client1 as any);
      testSession.removeClient("client-1");
      // Reconnect before the (1ms) delay is observed on the next tick.
      testSession.addClient(client1 as any);

      // Give the timer more than enough time to have fired had it not been
      // cancelled by the reconnect.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(cleanupCalled).toBe(false);

      await testSession[Symbol.asyncDispose]();
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
      const update = createTestUpdate();
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

        const update = createTestUpdate();
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

        const update = createTestUpdate();
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

    describe("attribution", () => {
      it("stores attribution for unencrypted updates", async () => {
        await session.load();
        session.addClient(client1 as any);

        const update = createTestUpdate("hello");
        const context = { clientId: "client-1", userId: "user-1", room: "room" } as ServerContext;
        const message = new DocMessage("test-doc", { type: "update", update }, context, false);

        await session.apply(message, client1 as any);

        const attribution = await storage.retrieveAttribution("test-doc");
        expect(attribution).not.toBeNull();

        const map = decodeContentMap(attribution!);
        const insertClients = [...map.inserts.clients.values()];
        expect(insertClients.length).toBeGreaterThan(0);
        const attrs = insertClients.flatMap((r) =>
          r.getIds().flatMap((range) => range.attrs.filter((a) => a.name === "insert")),
        );
        expect(attrs.some((a) => a.val === "user-1")).toBe(true);
      });

      it("stores attribution for encrypted updates", async () => {
        MemoryDocumentStorage.docs.clear();
        MemoryDocumentStorage.pendingUpdates.clear();
        MemoryDocumentStorage.attributionMaps.clear();
        const encStorage = new MemoryDocumentStorage(true);

        const encSession = new Session({
          documentId: "enc-doc",
          namespacedDocumentId: "enc-doc",
          id: "session-enc-attr",
          encrypted: true,
          storage: encStorage,
          pubSub,
          nodeId,
          onCleanupScheduled: () => {},
          server: mockServer,
        });

        await encSession.load();
        encSession.addClient(client1 as any);

        const doc = new Y.Doc();
        doc.getText("t").insert(0, "Hello");
        const v1Update = Y.encodeStateAsUpdate(doc);
        const { update: structureUpdate, sidecar } = stripContent(v1Update, 1);
        const sidecarBytes = encodeSidecar(sidecar);

        const encPayload = encodeContentEncryptedPayload({
          structureUpdate,
          encryptedSidecars: [sidecarBytes as EncryptedBinary],
        });

        await encSession.apply(
          new DocMessage(
            "enc-doc",
            {
              type: "update",
              update: { version: 2, data: encPayload } as VersionedUpdate,
            },
            { clientId: "client-1", userId: "user-1", room: "room" } as ServerContext,
            true,
          ),
          client1 as any,
        );

        const attribution = await encStorage.retrieveAttribution("enc-doc");
        expect(attribution).not.toBeNull();

        const map = decodeContentMap(attribution!);
        const insertClients = [...map.inserts.clients.values()];
        expect(insertClients.length).toBeGreaterThan(0);
        const attrs = insertClients.flatMap((r) =>
          r.getIds().flatMap((range) => range.attrs.filter((a) => a.name === "insert")),
        );
        expect(attrs.some((a) => a.val === "user-1")).toBe(true);

        await encSession[Symbol.asyncDispose]();
      });

      it("emits document-attribution event for encrypted updates", async () => {
        MemoryDocumentStorage.docs.clear();
        MemoryDocumentStorage.pendingUpdates.clear();
        MemoryDocumentStorage.attributionMaps.clear();
        const encStorage = new MemoryDocumentStorage(true);

        const encSession = new Session({
          documentId: "enc-doc",
          namespacedDocumentId: "enc-doc",
          id: "session-enc-evt",
          encrypted: true,
          storage: encStorage,
          pubSub,
          nodeId,
          onCleanupScheduled: () => {},
          server: mockServer,
        });

        await encSession.load();
        encSession.addClient(client1 as any);

        let attributionEventFired = false;
        encSession.on("document-attribution", () => {
          attributionEventFired = true;
        });

        const doc = new Y.Doc();
        doc.getText("t").insert(0, "Test");
        const v1Update = Y.encodeStateAsUpdate(doc);
        const { update: structureUpdate, sidecar } = stripContent(v1Update, 1);
        const sidecarBytes = encodeSidecar(sidecar);

        const encPayload = encodeContentEncryptedPayload({
          structureUpdate,
          encryptedSidecars: [sidecarBytes as EncryptedBinary],
        });

        await encSession.apply(
          new DocMessage(
            "enc-doc",
            {
              type: "update",
              update: { version: 2, data: encPayload } as VersionedUpdate,
            },
            { clientId: "client-1", userId: "user-1", room: "room" } as ServerContext,
            true,
          ),
          client1 as any,
        );

        expect(attributionEventFired).toBe(true);

        await encSession[Symbol.asyncDispose]();
      });
    });

    describe("sync-step-2", () => {
      it("should handle sync-step-2 message", async () => {
        await session.load();
        session.addClient(client1 as any);
        session.addClient(client2 as any);

        const update = createTestUpdate() as unknown as VersionedSyncStep2Update;
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
        const update = createTestUpdate() as unknown as VersionedSyncStep2Update;
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

    describe("encrypted session operations", () => {
      let encSession: Session<ServerContext>;
      let encStorage: MemoryDocumentStorage;
      let encPubSub: InMemoryPubSub;
      let encClient1: MockClient<ServerContext>;
      let encClient2: MockClient<ServerContext>;

      function createEncryptedUpdate(content = "test") {
        const doc = new Y.Doc();
        doc.getText("t").insert(0, content);
        const v1Update = Y.encodeStateAsUpdate(doc);
        const { update: structureUpdate, sidecar } = stripContent(v1Update, 1);
        const sidecarBytes = encodeSidecar(sidecar);
        const encPayload = encodeContentEncryptedPayload({
          structureUpdate,
          encryptedSidecars: [sidecarBytes as EncryptedBinary],
        });
        return { version: 2, data: encPayload } as VersionedUpdate;
      }

      beforeEach(() => {
        MemoryDocumentStorage.docs.clear();
        MemoryDocumentStorage.pendingUpdates.clear();
        MemoryDocumentStorage.attributionMaps.clear();
        encStorage = new MemoryDocumentStorage(true);
        encPubSub = new InMemoryPubSub();
        encClient1 = new MockClient<ServerContext>("enc-client-1");
        encClient2 = new MockClient<ServerContext>("enc-client-2");

        encSession = new Session({
          documentId: "enc-doc",
          namespacedDocumentId: "enc-doc",
          id: "session-enc-ops",
          encrypted: true,
          storage: encStorage,
          pubSub: encPubSub,
          nodeId,
          onCleanupScheduled: () => {},
          server: mockServer,
        });
      });

      afterEach(async () => {
        await encSession[Symbol.asyncDispose]();
        await encPubSub[Symbol.asyncDispose]();
      });

      it("sync-step-1 returns sync-step-2 and sync-step-1 echo", async () => {
        await encSession.load();
        encSession.addClient(encClient1 as any);

        const stateVector = new Uint8Array([1, 2, 3]) as StateVector;
        const message = new DocMessage(
          "enc-doc",
          { type: "sync-step-1", sv: stateVector },
          { clientId: "enc-client-1", userId: "user-1", room: "room" } as ServerContext,
          true,
        );

        await encSession.apply(message, encClient1 as any);

        expect(encClient1.sentMessages.length).toBe(2);
        expect(encClient1.sentMessages[0].payload.type).toBe("sync-step-2");
        expect(encClient1.sentMessages[1].payload.type).toBe("sync-step-1");
      });

      it("update is stored, broadcast to other clients, and published to pubSub", async () => {
        await encSession.load();
        encSession.addClient(encClient1 as any);
        encSession.addClient(encClient2 as any);

        const encUpdate = createEncryptedUpdate("hello");
        const message = new DocMessage(
          "enc-doc",
          { type: "update", update: encUpdate },
          { clientId: "enc-client-1", userId: "user-1", room: "room" } as ServerContext,
          true,
        );

        await encSession.apply(message, encClient1 as any);

        // Should be stored
        const doc = await encStorage.getDocument("enc-doc");
        expect(doc).not.toBeNull();

        // Should broadcast to other client, not originating client
        expect(encClient2.sentMessages.length).toBe(1);
        expect(encClient1.sentMessages.length).toBe(0);
      });

      it("sync-step-2 sends sync-done back to the client", async () => {
        await encSession.load();
        encSession.addClient(encClient1 as any);
        encSession.addClient(encClient2 as any);

        const encUpdate = createEncryptedUpdate("step2") as unknown as VersionedSyncStep2Update;
        const message = new DocMessage(
          "enc-doc",
          { type: "sync-step-2", update: encUpdate },
          { clientId: "enc-client-1", userId: "user-1", room: "room" } as ServerContext,
          true,
        );

        await encSession.apply(message, encClient1 as any);

        // Should broadcast to other clients
        expect(encClient2.sentMessages.length).toBe(1);
        // Should send sync-done to originating client
        expect(encClient1.sentMessages.length).toBe(1);
        expect(encClient1.sentMessages[0].payload.type).toBe("sync-done");
      });

      it("encrypted update round-trip: client A sends, client B receives broadcast", async () => {
        await encSession.load();
        encSession.addClient(encClient1 as any);
        encSession.addClient(encClient2 as any);

        const encUpdate = createEncryptedUpdate("round-trip");
        const message = new DocMessage(
          "enc-doc",
          { type: "update", update: encUpdate },
          { clientId: "enc-client-1", userId: "user-1", room: "room" } as ServerContext,
          true,
        );

        await encSession.apply(message, encClient1 as any);

        // Client B should have received the broadcast
        expect(encClient2.sentMessages.length).toBe(1);
        const broadcastMsg = encClient2.sentMessages[0];
        expect(broadcastMsg.type).toBe("doc");
        expect(broadcastMsg.payload.type).toBe("update");
        expect(broadcastMsg.encrypted).toBe(true);

        // The broadcast payload should contain data
        const broadcastUpdate = (broadcastMsg.payload as any).update as VersionedUpdate;
        expect(broadcastUpdate.version).toBe(2);
        expect(broadcastUpdate.data).toBeInstanceOf(Uint8Array);
        expect(broadcastUpdate.data.length).toBeGreaterThan(0);
      });

      it("encrypted session rejects unencrypted doc messages", async () => {
        await encSession.load();
        encSession.addClient(encClient1 as any);

        const message = new DocMessage(
          "enc-doc",
          { type: "sync-done" },
          { clientId: "enc-client-1", userId: "user-1", room: "room" } as ServerContext,
          false, // Not encrypted
        );

        await expect(encSession.apply(message)).rejects.toThrow(
          "Message encryption and document encryption are mismatched",
        );
      });

      it("rapid encrypted updates are all stored", async () => {
        await encSession.load();
        encSession.addClient(encClient1 as any);

        for (let i = 0; i < 10; i++) {
          const doc = new Y.Doc();
          doc.getText("t").insert(0, `update-${i}`);
          const v1Update = Y.encodeStateAsUpdate(doc);
          const { update: structureUpdate, sidecar } = stripContent(v1Update, 1);
          const sidecarBytes = encodeSidecar(sidecar);
          const encPayload = encodeContentEncryptedPayload({
            structureUpdate,
            encryptedSidecars: [sidecarBytes as EncryptedBinary],
          });
          const update = { version: 2, data: encPayload } as VersionedUpdate;

          const message = new DocMessage(
            "enc-doc",
            { type: "update", update },
            { clientId: "enc-client-1", userId: "user-1", room: "room" } as ServerContext,
            true,
          );

          await encSession.apply(message, encClient1 as any);
        }

        // All updates should be stored — the document should exist and have content
        const doc = await encStorage.getDocument("enc-doc");
        expect(doc).not.toBeNull();
        expect(doc!.content.update).toBeInstanceOf(Uint8Array);
        expect(doc!.content.update.length).toBeGreaterThan(0);

        // State vector should reflect all 10 client contributions
        expect(doc!.content.stateVector).toBeInstanceOf(Uint8Array);
        expect(doc!.content.stateVector.length).toBeGreaterThan(0);
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

      await expect(unloadedSession[Symbol.asyncDispose]()).resolves.toBeUndefined();
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
        // Wait a bit to ensure cleanup doesn't fire (cleanup delay is 60s, so 10ms is safe)
        setTimeout(() => {
          expect(cleanupCalled).toBe(false);
          done();
        }, 10);
      });
    });
  });

  describe("events", () => {
    let session: Session<ServerContext>;
    let _cleanupScheduled = false;
    const onCleanupScheduled = () => {
      _cleanupScheduled = true;
    };

    beforeEach(async () => {
      _cleanupScheduled = false;
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
          update: createTestUpdate() as unknown as VersionedSyncStep2Update,
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
          update: createTestUpdate() as unknown as VersionedSyncStep2Update,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      // Call apply with replication meta to simulate replicated message
      await session.apply(message, undefined, {
        sourceNodeId: "node-2",
        deduped: false,
      });

      const replEvents = events.filter((e) => e.source === "replication" && e.deduped === false);
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
          update: createTestUpdate() as unknown as VersionedSyncStep2Update,
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
          update: createTestUpdate() as unknown as VersionedSyncStep2Update,
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
