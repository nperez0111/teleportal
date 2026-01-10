import { describe, expect, it } from "bun:test";
import {
  DocMessage,
  InMemoryPubSub,
  type Message,
  type ServerContext,
  type StateVector,
  type Update,
} from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
} from "teleportal/storage";
import { Server } from "./server";

class MinimalDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";
  fileStorage = undefined;
  milestoneStorage = undefined;

  async handleSyncStep1(
    documentId: string,
    sv: StateVector,
  ): Promise<Document> {
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: new Uint8Array([1, 2, 3]) as unknown as Update,
        stateVector: sv,
      },
    };
  }

  async handleSyncStep2(): Promise<void> {
    return;
  }

  async handleUpdate(): Promise<void> {
    return;
  }

  async getDocument(): Promise<Document | null> {
    return null;
  }

  async writeDocumentMetadata(): Promise<void> {
    return;
  }

  async getDocumentMetadata(_documentId: string): Promise<DocumentMetadata> {
    const now = Date.now();
    return { createdAt: now, updatedAt: now, encrypted: false };
  }

  async deleteDocument(): Promise<void> {
    return;
  }

  transaction<T>(_documentId: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  async addFileToDocument(): Promise<void> {
    return;
  }

  async removeFileFromDocument(): Promise<void> {
    return;
  }
}

describe("Server events", () => {
  it("emits document/client/message lifecycle events", async () => {
    const pubSub = new InMemoryPubSub();
    const storageByDoc = new Map<string, MinimalDocumentStorage>();

    const server = new Server<ServerContext>({
      pubSub,
      getStorage: async ({ documentId }) => {
        const existing = storageByDoc.get(documentId);
        if (existing) return existing;
        const created = new MinimalDocumentStorage();
        storageByDoc.set(documentId, created);
        return created;
      },
    });

    const seen: Array<{ name: string; event: any }> = [];

    server.events.on("document-load", (event) => {
      seen.push({ name: "document-load", event });
    });
    server.events.on("client-connect", (event) => {
      seen.push({ name: "client-connect", event });
    });
    server.events.on("client-disconnect", (event) => {
      seen.push({ name: "client-disconnect", event });
    });
    server.events.on("document-client-connect", (event) => {
      seen.push({ name: "document-client-connect", event });
    });
    server.events.on("document-client-disconnect", (event) => {
      seen.push({ name: "document-client-disconnect", event });
    });
    server.events.on("client-message", (event) => {
      seen.push({ name: "client-message", event });
    });
    server.events.on("document-message", (event) => {
      seen.push({ name: "document-message", event });
    });
    server.events.on("document-unload", (event) => {
      seen.push({ name: "document-unload", event });
    });

    const outbound: Message<ServerContext>[] = [];

    const context: ServerContext = {
      clientId: "client-1",
      userId: "user-1",
      room: "room-1",
    };

    const incoming = new DocMessage(
      "test-doc",
      { type: "sync-step-1", sv: new Uint8Array() as unknown as StateVector },
      context,
      false,
    );

    const transport = {
      readable: new ReadableStream<Message<ServerContext>>({
        start(controller) {
          controller.enqueue(incoming);
          controller.close();
        },
      }),
      writable: new WritableStream<Message<ServerContext>>({
        write(message) {
          outbound.push(message);
        },
      }),
    };

    server.createClient({ transport, id: "client-1" });

    // Let the server process the message + ACK.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Force unload events to fire deterministically.
    await server[Symbol.asyncDispose]();

    expect(seen.some((e) => e.name === "client-connect")).toBe(true);
    expect(seen.some((e) => e.name === "document-load")).toBe(true);
    expect(seen.some((e) => e.name === "document-client-connect")).toBe(true);
    expect(seen.some((e) => e.name === "client-message" && e.event.direction === "in")).toBe(true);
    expect(seen.some((e) => e.name === "client-message" && e.event.direction === "out")).toBe(true);
    expect(seen.some((e) => e.name === "document-message" && e.event.source === "client")).toBe(true);
    expect(seen.some((e) => e.name === "client-disconnect")).toBe(true);
    expect(seen.some((e) => e.name === "document-client-disconnect")).toBe(true);
    expect(seen.some((e) => e.name === "document-unload" && e.event.reason === "dispose")).toBe(true);

    // Ensure server actually responded to the client.
    expect(outbound.length).toBeGreaterThan(0);
  });
});

