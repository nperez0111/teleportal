import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { ServerContext, StateVector, Update } from "teleportal";
import { DocMessage } from "teleportal";
import type { Document, DocumentMetadata, DocumentStorage } from "teleportal/storage";
import { Server } from "teleportal/server";
import { DurableStreamsConnection } from "./connection";
import { getDurableStreamsTeleportalHandler } from "../../durable-streams/teleportal-server";

class MockDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";
  fileStorage = undefined;
  milestoneStorage = undefined;

  storedUpdate: Update | null = null;
  metadata: Map<string, DocumentMetadata> = new Map();

  async handleSyncStep1(documentId: string, syncStep1: StateVector): Promise<Document> {
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: new Uint8Array([1, 2, 3]) as unknown as Update,
        stateVector: syncStep1,
      },
    };
  }

  async handleSyncStep2(_documentId: string, _syncStep2: any): Promise<void> {
    return;
  }

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

  async addFileToDocument(_documentId: string, _fileId: string): Promise<void> {}
  async removeFileFromDocument(_documentId: string, _fileId: string): Promise<void> {}
}

describe("DurableStreamsConnection (teleportal bridge)", () => {
  let server: Server<ServerContext>;
  let handler: (req: Request) => Promise<Response>;
  let client: DurableStreamsConnection;

  beforeEach(() => {
    server = new Server({
      getStorage: async () => new MockDocumentStorage(),
    });

    handler = getDurableStreamsTeleportalHandler({
      server,
      getContext: async () => ({
        userId: "user-1",
        room: "room-1",
      }),
    });
  });

  afterEach(async () => {
    if (client) await client.destroy();
    await server[Symbol.asyncDispose]();
  });

  function makeInMemoryFetch(baseUrl: string): typeof fetch {
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const absolute = url.startsWith("http") ? url : `${baseUrl}${url}`;
      const req = new Request(absolute, init);
      return await handler(req);
    }) as typeof fetch;
    (f as any).preconnect = () => {};
    return f;
  }

  test("should connect and receive server responses over durable streams", async () => {
    const baseUrl = "http://example.com";
    client = new DurableStreamsConnection({
      url: baseUrl,
      fetch: makeInMemoryFetch(baseUrl),
    });

    await client.connected;
    expect(client.state.type).toBe("connected");

    const received: string[] = [];
    const unsub = client.on("message", (m) => {
      if (m.type === "doc") {
        received.push((m.payload as any).type);
      }
    });

    // Kick off Yjs sync.
    await client.send(
      new DocMessage(
        "doc-1",
        { type: "sync-step-1", sv: new Uint8Array() as any },
        undefined,
        false,
      ),
    );

    // Wait briefly for long-poll loop to pick up outbound stream appends.
    await new Promise((r) => setTimeout(r, 20));

    unsub();

    // Server responds to sync-step-1 with sync-step-2 and then sync-step-1 (see Session.apply).
    expect(received).toContain("sync-step-2");
    expect(received).toContain("sync-step-1");
  });
});

