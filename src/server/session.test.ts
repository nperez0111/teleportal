import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
  Message,
  ServerContext,
  StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";
import { DocMessage, InMemoryPubSub } from "teleportal";
import { DocumentStorage } from "teleportal/storage";
import { logger } from "./logger";
import { Session } from "./session";
import { Client } from "./client";
import { ConsoleTransport, LogLayer } from "loglayer";

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
    this.mockHandleSyncStep2 = true;
    this.lastSyncStep2 = syncStep2;
    return Promise.resolve();
  }
  public encrypted = false;
  public mockFetch = false;
  public mockWrite = false;
  public mockHandleSyncStep2 = false;
  public storedData: any = null;
  public lastSyncStep2: SyncStep2Update | null = null;

  async fetch(documentId: string) {
    this.mockFetch = true;
    return this.storedData;
  }

  async write(documentId: string, update: Update) {
    this.mockWrite = true;
    this.storedData = update;
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
      logger: new LogLayer({
        transport: new ConsoleTransport({
          logger: console,
          enabled: false,
        }),
      }),
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
        logger: new LogLayer({
          transport: new ConsoleTransport({
            logger: console,
            enabled: false,
          }),
        }),
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
        logger: new LogLayer({
          transport: new ConsoleTransport({
            logger: console,
            enabled: false,
          }),
        }),
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
        logger: new LogLayer({
          transport: new ConsoleTransport({
            logger: console,
            enabled: false,
          }),
        }),
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
        logger: new LogLayer({
          transport: new ConsoleTransport({
            logger: console,
            enabled: false,
          }),
        }),
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

      expect(storage.mockWrite).toBe(true);
      expect(storage.storedData).toBe(update);
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
        logger: new LogLayer({
          transport: new ConsoleTransport({
            logger: console,
            enabled: false,
          }),
        }),
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
        expect(storage.mockWrite).toBe(true);
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
          logger: new LogLayer({
            transport: new ConsoleTransport({
              logger: console,
              enabled: false,
            }),
          }),
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
        logger: new LogLayer({
          transport: new ConsoleTransport({
            logger: console,
            enabled: false,
          }),
        }),
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
        logger: new LogLayer({
          transport: new ConsoleTransport({
            logger: console,
            enabled: false,
          }),
        }),
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
});
