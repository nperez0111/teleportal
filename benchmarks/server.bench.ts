import { describe, it, beforeEach, afterEach } from "bun:test";
import * as Y from "yjs";
import { Server } from "../src/server/server";
import { MemoryDocumentStorage } from "../src/storage/in-memory/document-storage";
import {
  DocMessage,
  InMemoryPubSub,
  type Message,
  type ServerContext,
  type StateVector,
  type Transport,
  type Update,
  type VersionedUpdate,
} from "teleportal";
import { createChannel } from "../src/lib/iter";
import { bench, benchBatch, flush } from "./helpers";

class BenchTransport<Context extends ServerContext> implements Transport<Context> {
  public source: AsyncIterable<Message<Context>[]>;
  #channel = createChannel<Message<Context>>();

  constructor() {
    this.source = this.#channel;
  }

  write(_message: Message<Context>): void {}
  close(): void {}
  async destroy() {}

  enqueueMessage(message: Message<Context>) {
    try {
      this.#channel.send(message);
    } catch {}
  }

  closeReadable() {
    this.#channel.close();
  }

  [key: string]: unknown;
}

function makeDocUpdate(docId: string, content: string): DocMessage<ServerContext> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const update = Y.encodeStateAsUpdateV2(doc);
  return new DocMessage(
    docId,
    {
      type: "update",
      update: { version: 2, data: update as Update } as VersionedUpdate,
    },
    { userId: "bench-user", room: "bench", clientId: "bench-client" },
    false,
  );
}

function makeSyncStep1(docId: string): DocMessage<ServerContext> {
  const doc = new Y.Doc();
  const sv = Y.encodeStateVector(doc);
  return new DocMessage(
    docId,
    { type: "sync-step-1", sv: sv as StateVector },
    { userId: "bench-user", room: "bench", clientId: "bench-client" },
    false,
  );
}

describe("Server Benchmarks", () => {
  let server: Server<ServerContext>;
  let storage: MemoryDocumentStorage;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    pubSub = new InMemoryPubSub();
    storage = new MemoryDocumentStorage(false);
    server = new Server<ServerContext>({
      storage,
      pubSub,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  describe("Session Management", () => {
    it("getOrOpenSession - new session", async () => {
      let i = 0;
      await bench(
        "open new session",
        () =>
          server.getOrOpenSession(`session-doc-${i++}`, {
            encrypted: false,
            context: { userId: "user-1", room: "bench", clientId: "client-1" },
          }),
        { iterations: 200 },
      );
    });

    it("getOrOpenSession - existing session", async () => {
      await server.getOrOpenSession("existing-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "bench", clientId: "client-1" },
      });

      await bench(
        "get existing session",
        () =>
          server.getOrOpenSession("existing-doc", {
            encrypted: false,
            context: { userId: "user-1", room: "bench", clientId: "client-1" },
          }),
        { iterations: 1000 },
      );
    });
  });

  describe("Client Management", () => {
    it("createClient", async () => {
      await bench(
        "createClient",
        () => {
          const transport = new BenchTransport<ServerContext>();
          server.createClient({ transport });
          transport.closeReadable();
        },
        { iterations: 500 },
      );
    });

    it("createClient + disconnect", async () => {
      await bench(
        "createClient + disconnect",
        () => {
          const transport = new BenchTransport<ServerContext>();
          const client = server.createClient({ transport });
          server.disconnectClient(client);
          transport.closeReadable();
        },
        { iterations: 500 },
      );
    });
  });

  describe("Message Processing", () => {
    it("process update message through server", async () => {
      const transport = new BenchTransport<ServerContext>();
      server.createClient({ transport });

      let i = 0;
      await bench(
        "process update message",
        async () => {
          transport.enqueueMessage(makeDocUpdate("msg-doc", `update-${i++}`));
          await flush();
        },
        { iterations: 200 },
      );
      transport.closeReadable();
    });

    it("process sync-step-1 through server", async () => {
      const transport = new BenchTransport<ServerContext>();
      server.createClient({ transport });

      await bench(
        "process sync-step-1",
        async () => {
          transport.enqueueMessage(makeSyncStep1("sync-doc"));
          await flush();
        },
        { iterations: 200 },
      );
      transport.closeReadable();
    });

    it("burst of updates to same document", async () => {
      const transport = new BenchTransport<ServerContext>();
      server.createClient({ transport });

      const batchSize = 50;
      await benchBatch(
        `burst ${batchSize} updates`,
        async () => {
          for (let j = 0; j < batchSize; j++) {
            transport.enqueueMessage(makeDocUpdate("burst-doc", `u${j}`));
          }
          await flush();
          await new Promise((r) => setTimeout(r, 1));
        },
        { batchSize, iterations: 20 },
      );
      transport.closeReadable();
    });

    it("updates to many different documents", async () => {
      const transport = new BenchTransport<ServerContext>();
      server.createClient({ transport });

      let docNum = 0;
      const batchSize = 20;
      await benchBatch(
        `updates to ${batchSize} different docs`,
        async () => {
          for (let j = 0; j < batchSize; j++) {
            transport.enqueueMessage(makeDocUpdate(`multi-doc-${docNum++}`, "content"));
          }
          await flush();
          await new Promise((r) => setTimeout(r, 1));
        },
        { batchSize, iterations: 20 },
      );
      transport.closeReadable();
    });
  });

  describe("Multi-Client", () => {
    it("fan-out to multiple clients on same doc", async () => {
      const clientCount = 10;
      const transports: BenchTransport<ServerContext>[] = [];
      for (let i = 0; i < clientCount; i++) {
        const transport = new BenchTransport<ServerContext>();
        server.createClient({ transport });
        transports.push(transport);
      }

      // Open the session for all clients
      for (const t of transports) {
        t.enqueueMessage(makeSyncStep1("fanout-doc"));
      }
      await flush();
      await new Promise((r) => setTimeout(r, 10));

      await bench(
        `fan-out update to ${clientCount} clients`,
        async () => {
          transports[0].enqueueMessage(makeDocUpdate("fanout-doc", "x"));
          await flush();
        },
        { iterations: 100 },
      );

      for (const t of transports) t.closeReadable();
    });
  });
});
