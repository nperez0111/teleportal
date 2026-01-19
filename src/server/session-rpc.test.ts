import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
  Message,
  ServerContext,
  StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";
import { RpcMessage } from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
  MilestoneStorage,
} from "teleportal/storage";
import { InMemoryPubSub } from "teleportal";
import { Session } from "./session";
import { Server } from "./server";

class MockClient<Context extends ServerContext> {
  public id: string;
  public sentMessages: Message<Context>[] = [];

  constructor(id: string) {
    this.id = id;
  }

  async send(message: Message<Context>) {
    this.sentMessages.push(message);
  }
}

class MockDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";

  fileStorage = undefined;
  milestoneStorage: MilestoneStorage | undefined = undefined;

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
  ): Promise<void> {}

  async handleUpdate(_documentId: string, update: Update): Promise<void> {
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
    getStorage: async () => {
      throw new Error("Not implemented in mock");
    },
  });
}

describe("Session RPC Integration", () => {
  let session: Session<ServerContext>;
  let storage: MockDocumentStorage;
  let pubSub: InMemoryPubSub;
  let client: MockClient<ServerContext>;
  const nodeId = "test-node";
  let mockServer: Server<ServerContext>;

  beforeEach(() => {
    storage = new MockDocumentStorage();
    pubSub = new InMemoryPubSub();
    client = new MockClient<ServerContext>("client-1");
    mockServer = createMockServer();

    session = new Session({
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      id: "session-1",
      encrypted: false,
      storage,
      pubSub: pubSub,
      nodeId,
      onCleanupScheduled: () => {},
      server: mockServer,
    });
  });

  afterEach(async () => {
    await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  describe("constructor", () => {
    it("should accept rpcHandlers in constructor", () => {
      const rpcHandlers = {};
      const sessionWithHandlers = new Session({
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        id: "session-2",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {},
        rpcHandlers,
        server: mockServer,
      });
      expect(sessionWithHandlers).toBeDefined();
    });
  });

  describe("RPC message handling", () => {
    it("should handle RPC request message", async () => {
      await session.load();
      session.addClient(client as any);

      const rpcHandlers = {
        testMethod: {
          handler: async (_payload: unknown, _context: unknown) => {
            return {
              response: { result: "test" },
            };
          },
        },
      };

      const sessionWithHandlers = new Session({
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        id: "session-3",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {},
        rpcHandlers,
        server: mockServer,
      });

      const rpcMessage = new RpcMessage<ServerContext>(
        "test-doc",
        { type: "success", payload: { data: "test" } },
        "testMethod",
        "request",
        undefined,
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await sessionWithHandlers.apply(rpcMessage, client as any);

      expect(client.sentMessages.length).toBe(1);
      const response = client.sentMessages[0];
      expect(response).toBeInstanceOf(RpcMessage);
      if (response instanceof RpcMessage) {
        expect(response.requestType).toBe("response");
        expect(response.payload).toEqual({
          type: "success",
          payload: { result: "test" },
        });
      }

      await sessionWithHandlers[Symbol.asyncDispose]();
    });

    it("should return error for unknown RPC method", async () => {
      await session.load();
      session.addClient(client as any);

      const rpcHandlers = {};

      const sessionWithHandlers = new Session({
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        id: "session-4",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {},
        rpcHandlers,
        server: mockServer,
      });

      const rpcMessage = new RpcMessage<ServerContext>(
        "test-doc",
        { type: "success", payload: { data: "test" } },
        "unknownMethod",
        "request",
        undefined,
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await sessionWithHandlers.apply(rpcMessage, client as any);

      expect(client.sentMessages.length).toBe(1);
      const response = client.sentMessages[0];
      expect(response).toBeInstanceOf(RpcMessage);
      if (response instanceof RpcMessage) {
        expect(response.requestType).toBe("response");
        expect(response.payload).toEqual({
          type: "error",
          statusCode: 501,
          details: "Unknown RPC method: unknownMethod",
          payload: { method: "unknownMethod" },
        });
      }

      await sessionWithHandlers[Symbol.asyncDispose]();
    });

    it("should return error when handler throws", async () => {
      await session.load();
      session.addClient(client as any);

      const rpcHandlers = {
        failingMethod: {
          handler: async (_payload: unknown, _context: unknown) => {
            throw new Error("Handler error");
          },
        },
      };

      const sessionWithHandlers = new Session({
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        id: "session-5",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {},
        rpcHandlers,
        server: mockServer,
      });

      const rpcMessage = new RpcMessage<ServerContext>(
        "test-doc",
        { type: "success", payload: {} },
        "failingMethod",
        "request",
        undefined,
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await sessionWithHandlers.apply(rpcMessage, client as any);

      expect(client.sentMessages.length).toBe(1);
      const response = client.sentMessages[0];
      expect(response).toBeInstanceOf(RpcMessage);
      if (response instanceof RpcMessage) {
        expect(response.requestType).toBe("response");
        expect(response.payload).toEqual({
          type: "error",
          statusCode: 500,
          details: "Handler error",
        });
      }

      await sessionWithHandlers[Symbol.asyncDispose]();
    });

    it("should not respond to RPC request without client", async () => {
      await session.load();

      const rpcHandlers = {
        testMethod: {
          handler: async (payload: unknown, _context: unknown) => {
            return { response: payload };
          },
        },
      };

      const sessionWithHandlers = new Session({
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        id: "session-6",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {},
        rpcHandlers,
        server: mockServer,
      });

      const rpcMessage = new RpcMessage<ServerContext>(
        "test-doc",
        { type: "success", payload: {} },
        "testMethod",
        "request",
        undefined,
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await sessionWithHandlers.apply(rpcMessage);

      expect(client.sentMessages.length).toBe(0);

      await sessionWithHandlers[Symbol.asyncDispose]();
    });

    it("should preserve request ID in RPC response", async () => {
      await session.load();
      session.addClient(client as any);

      const rpcHandlers = {
        testMethod: {
          handler: async (payload: unknown, _context: unknown) => {
            return { response: payload };
          },
        },
      };

      const sessionWithHandlers = new Session({
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        id: "session-7",
        encrypted: false,
        storage,
        pubSub,
        nodeId,
        onCleanupScheduled: () => {},
        rpcHandlers,
        server: mockServer,
      });

      const rpcMessage = new RpcMessage<ServerContext>(
        "test-doc",
        { type: "success", payload: {} },
        "testMethod",
        "request",
        undefined,
        { clientId: "client-1", userId: "user-1", room: "room" },
        false,
      );

      await sessionWithHandlers.apply(rpcMessage, client as any);

      expect(client.sentMessages.length).toBe(1);
      const response = client.sentMessages[0];
      expect(response).toBeInstanceOf(RpcMessage);
      if (response instanceof RpcMessage) {
        expect(response.originalRequestId).toBe(rpcMessage.id);
      }

      await sessionWithHandlers[Symbol.asyncDispose]();
    });
  });
});
