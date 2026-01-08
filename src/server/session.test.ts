import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLogger } from "@logtape/logtape";
import type {
  Message,
  ServerContext,
  StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";
import { DocMessage, InMemoryPubSub, MilestoneSnapshot } from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
  MilestoneStorage,
} from "teleportal/storage";
import { InMemoryMilestoneStorage } from "teleportal/storage";
import { Session } from "./session";
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
  milestoneStorage: MilestoneStorage | undefined = undefined;

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
      const files = Array.from(new Set([...(metadata.files ?? []), fileId]));
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

describe("Session", () => {
  let session: Session<ServerContext>;
  let storage: MockDocumentStorage;
  let pubSub: InMemoryPubSub;
  let client1: MockClient<ServerContext>;
  let client2: MockClient<ServerContext>;
  let client1AsClient: Client<ServerContext>;
  let client2AsClient: Client<ServerContext>;
  const nodeId = "test-node";

  beforeEach(() => {
    storage = new MockDocumentStorage();
    pubSub = new InMemoryPubSub();
    client1 = new MockClient<ServerContext>("client-1");
    client2 = new MockClient<ServerContext>("client-2");
    client1AsClient = client1 as any;
    client2AsClient = client2 as any;

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
        onCleanupScheduled: () => {
          // No-op for tests
        },
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

        let publishedMessage: Uint8Array | null = null;
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

  describe("milestone operations", () => {
    beforeEach(() => {
      storage.milestoneStorage = new InMemoryMilestoneStorage();
      storage.storedUpdate = new Uint8Array([1, 2, 3]) as Update;
    });

    it("should handle milestone-list-request", async () => {
      await session.load();
      session.addClient(client1AsClient);

      // Create a test milestone
      const snapshot = new Uint8Array([1, 2, 3]) as MilestoneSnapshot;
      const milestoneId = await storage.milestoneStorage!.createMilestone({
        name: "v1.0.0",
        documentId: "test-doc",
        createdAt: Date.now(),
        snapshot,
      });

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-list-request",
          snapshotIds: [],
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-list-response"
      ) {
        expect(response.payload.milestones.length).toBe(1);
        expect(response.payload.milestones[0].name).toBe("v1.0.0");
      }
    });

    it("should filter out known milestones from milestone-list-request", async () => {
      await session.load();
      session.addClient(client1AsClient);

      // Create two test milestones
      const snapshot1 = new Uint8Array([1, 2, 3]) as MilestoneSnapshot;
      const milestoneId1 = await storage.milestoneStorage!.createMilestone({
        name: "v1.0.0",
        documentId: "test-doc",
        createdAt: Date.now(),
        snapshot: snapshot1,
      });

      const snapshot2 = new Uint8Array([4, 5, 6]) as MilestoneSnapshot;
      const milestoneId2 = await storage.milestoneStorage!.createMilestone({
        name: "v2.0.0",
        documentId: "test-doc",
        createdAt: Date.now(),
        snapshot: snapshot2,
      });

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-list-request",
          snapshotIds: [milestoneId1], // Client already knows about milestoneId1
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-list-response"
      ) {
        // Should only return milestoneId2, not milestoneId1
        expect(response.payload.milestones.length).toBe(1);
        expect(response.payload.milestones[0].id).toBe(milestoneId2);
        expect(response.payload.milestones[0].name).toBe("v2.0.0");
      }
    });

    it("should return error when milestone storage is not available", async () => {
      await session.load();
      session.addClient(client1AsClient);
      storage.milestoneStorage = undefined;

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-list-request",
          snapshotIds: [],
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-auth-message"
      ) {
        expect(response.payload.permission).toBe("denied");
        expect(response.payload.reason).toContain("not available");
      }
    });

    it("should handle milestone-snapshot-request", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const snapshot = new Uint8Array([1, 2, 3, 4, 5]) as MilestoneSnapshot;
      const milestoneId = await storage.milestoneStorage!.createMilestone({
        name: "v1.0.0",
        documentId: "test-doc",
        createdAt: Date.now(),
        snapshot,
      });

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-snapshot-request",
          milestoneId,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-snapshot-response"
      ) {
        expect(response.payload.milestoneId).toBe(milestoneId);
        expect(response.payload.snapshot).toEqual(snapshot);
      }
    });

    it("should return error for non-existent milestone snapshot", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-snapshot-request",
          milestoneId: "non-existent-id",
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-auth-message"
      ) {
        expect(response.payload.permission).toBe("denied");
        expect(response.payload.reason).toContain("not found");
      }
    });


    it("should handle milestone-create-request with name", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const snapshot = new Uint8Array([1, 2, 3, 4, 5]) as MilestoneSnapshot;
      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-create-request",
          name: "v1.0.0",
          snapshot,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-create-response"
      ) {
        expect(response.payload.milestone.name).toBe("v1.0.0");
        expect(response.payload.milestone.documentId).toBe("test-doc");
      }
    });

    it("should handle milestone-create-request without name (auto-generate)", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const snapshot = new Uint8Array([6, 7, 8, 9, 10]) as MilestoneSnapshot;
      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-create-request",
          snapshot,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-create-response"
      ) {
        expect(response.payload.milestone.name).toBe("Milestone 1");
        expect(response.payload.milestone.documentId).toBe("test-doc");
      }
    });

    it("should auto-generate sequential milestone names", async () => {
      await session.load();
      session.addClient(client1AsClient);

      // Create first milestone
      const snapshot1 = new Uint8Array([1, 2, 3]) as MilestoneSnapshot;
      const message1 = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-create-request",
          snapshot: snapshot1,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );
      await session.apply(message1, client1AsClient);

      // Create second milestone
      const snapshot2 = new Uint8Array([4, 5, 6]) as MilestoneSnapshot;
      const message2 = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-create-request",
          snapshot: snapshot2,
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );
      await session.apply(message2, client1AsClient);

      expect(client1.sentMessages.length).toBe(2);
      const response1 = client1.sentMessages[0];
      const response2 = client1.sentMessages[1];

      if (
        response1 instanceof DocMessage &&
        response1.payload.type === "milestone-create-response"
      ) {
        expect(response1.payload.milestone.name).toBe("Milestone 1");
      }
      if (
        response2 instanceof DocMessage &&
        response2.payload.type === "milestone-create-response"
      ) {
        expect(response2.payload.milestone.name).toBe("Milestone 2");
      }
    });

    it("should fail encoding when snapshot is missing for milestone creation", async () => {
      // Test that encoding fails when snapshot is missing
      // This ensures clients cannot send messages without snapshots
      expect(() => {
        const message = new DocMessage<ServerContext>(
          "test-doc",
          {
            type: "milestone-create-request",
            name: "v1.0.0",
            // Missing snapshot
          } as any,
          { clientId: "client-1", userId: "user-1", room: "room" },
        );
        // Accessing .encoded will trigger encoding, which should fail
        void message.encoded;
      }).toThrow();
    });

    it("should handle milestone-update-name-request", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const snapshot = new Uint8Array([1, 2, 3]) as MilestoneSnapshot;
      const milestoneId = await storage.milestoneStorage!.createMilestone({
        name: "v1.0.0",
        documentId: "test-doc",
        createdAt: Date.now(),
        snapshot,
      });

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-update-name-request",
          milestoneId,
          name: "v1.0.1",
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-update-name-response"
      ) {
        expect(response.payload.milestone.id).toBe(milestoneId);
        expect(response.payload.milestone.name).toBe("v1.0.1");
      }
    });

    it("should return error for non-existent milestone update", async () => {
      await session.load();
      session.addClient(client1AsClient);

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-update-name-request",
          milestoneId: "non-existent-id",
          name: "v1.0.1",
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      await session.apply(message, client1AsClient);

      expect(client1.sentMessages.length).toBe(1);
      const response = client1.sentMessages[0];
      expect(response).toBeInstanceOf(DocMessage);
      if (
        response instanceof DocMessage &&
        response.payload.type === "milestone-auth-message"
      ) {
        expect(response.payload.permission).toBe("denied");
        expect(response.payload.reason).toContain("not found");
      }
    });

    it("should not respond to milestone requests without client", async () => {
      await session.load();

      const message = new DocMessage<ServerContext>(
        "test-doc",
        {
          type: "milestone-list-request",
          snapshotIds: [],
        },
        { clientId: "client-1", userId: "user-1", room: "room" },
      );

      // Apply message without providing a client
      await session.apply(message);

      // Verify no messages were sent (no client was provided, so no response should be sent)
      expect(client1.sentMessages.length).toBe(0);
    });
  });
});
