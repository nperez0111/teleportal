import { describe, it } from "bun:test";
import * as Y from "yjs";
import { DirectConnection as Connection } from "../src/providers/connection";
import { Provider } from "../src/providers/provider";
import { createMemoryTransportPair } from "../src/providers/transports/memory";
import { encodeContentEncryptedPayload } from "../src/lib/protocol/encryption/encoding";
import { DocMessage, type UpdateV2, type SyncStep2UpdateV2 } from "teleportal";
import { bench, benchBatch, createLargeDoc, formatBytes } from "./helpers";

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function wrapV2(rawV2: Uint8Array): Uint8Array {
  return encodeContentEncryptedPayload({
    structureUpdate: rawV2,
    encryptedSidecars: [],
  });
}

async function createTestProvider(document = "bench-doc") {
  const [clientTransport, serverTransport] = createMemoryTransportPair();
  const clientConn = new Connection({
    transports: [clientTransport],
    connect: false,
    batchIntervalMs: 0,
  });
  const serverConn = new Connection({
    transports: [serverTransport],
    connect: false,
    batchIntervalMs: 0,
  });

  await Promise.all([clientConn.connect(), serverConn.connect()]);

  const provider = new Provider({
    connection: clientConn,
    document,
    encryptionKey: false,
    enableOfflinePersistence: false,
  });

  return { provider, clientConn, serverConn, clientTransport, serverTransport };
}

async function sendSyncDone(serverConn: Connection, document: string) {
  const syncDone = new DocMessage(document, { type: "sync-done" }, {}, false);
  await serverConn.send(syncDone);
  await flush();
}

describe("Sync & Provider Benchmarks", () => {
  describe("Connection", () => {
    it("send message through memory transport", async () => {
      const [clientTransport] = createMemoryTransportPair();
      const conn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      await conn.connect();

      const msg = new DocMessage("doc", { type: "sync-done" }, {}, false);
      await bench("Connection.send (memory transport)", () => conn.send(msg), { iterations: 1000 });

      conn.destroy();
    });

    it("connection setup + teardown", async () => {
      await bench(
        "Connection create + connect + destroy",
        async () => {
          const [clientTransport] = createMemoryTransportPair();
          const conn = new Connection({
            transports: [clientTransport],
            connect: false,
            batchIntervalMs: 0,
          });
          await conn.connect();
          conn.destroy();
        },
        { iterations: 200 },
      );
    });
  });

  describe("Provider Lifecycle", () => {
    it("create provider", async () => {
      const providers: Provider[] = [];
      await bench(
        "Provider create (no encryption)",
        async () => {
          const [clientTransport] = createMemoryTransportPair();
          const conn = new Connection({
            transports: [clientTransport],
            connect: false,
            batchIntervalMs: 0,
          });
          await conn.connect();
          const provider = new Provider({
            connection: conn,
            document: "bench-doc",
            encryptionKey: false,
            enableOfflinePersistence: false,
          });
          providers.push(provider);
        },
        { iterations: 200 },
      );
      for (const p of providers) p.destroy();
    });
  });

  describe("Document Sync", () => {
    it("initial sync (sync-step-1 exchange)", async () => {
      const { provider, serverConn } = await createTestProvider();

      await bench(
        "initial sync handshake",
        async () => {
          await sendSyncDone(serverConn, "bench-doc");
        },
        { iterations: 200 },
      );

      provider.destroy();
    });

    it("send incremental updates via provider", async () => {
      const { provider, serverConn } = await createTestProvider();
      await sendSyncDone(serverConn, "bench-doc");

      let i = 0;
      await bench(
        "provider incremental update",
        async () => {
          provider.doc.getText("content").insert(i++ % 100, "x");
          await flush();
        },
        { iterations: 500 },
      );

      // Let in-flight messages drain before tearing down
      await new Promise((r) => setTimeout(r, 10));
      provider.destroy();
    });

    it("apply update from remote", async () => {
      const { provider, serverConn } = await createTestProvider();
      await sendSyncDone(serverConn, "bench-doc");

      const remoteDoc = new Y.Doc();
      let i = 0;

      await bench(
        "apply remote update",
        async () => {
          const sv = Y.encodeStateVector(remoteDoc);
          remoteDoc.getText("content").insert(i++ % 100, "y");
          const diff = Y.encodeStateAsUpdateV2(remoteDoc, sv);
          const msg = new DocMessage(
            "bench-doc",
            {
              type: "update",
              update: { version: 2, data: wrapV2(diff) as UpdateV2 },
            },
            {},
            false,
          );
          await serverConn.send(msg);
          await flush();
        },
        { iterations: 500 },
      );

      provider.destroy();
    });

    it("large document initial load", async () => {
      for (const size of [1_000, 10_000, 50_000]) {
        const doc = createLargeDoc(size);
        const rawUpdate = Y.encodeStateAsUpdateV2(doc);
        const wrappedUpdate = wrapV2(rawUpdate);
        console.log(
          `    ${size} chars → ${formatBytes(rawUpdate.byteLength)} (raw), ${formatBytes(wrappedUpdate.byteLength)} (wrapped)`,
        );

        const { provider, serverConn } = await createTestProvider(`large-${size}`);

        await bench(
          `initial load ${size} chars`,
          async () => {
            const msg = new DocMessage(
              `large-${size}`,
              {
                type: "sync-step-2",
                update: { version: 2, data: wrappedUpdate as SyncStep2UpdateV2 },
              },
              {},
              false,
            );
            await serverConn.send(msg);
            await flush();
          },
          { iterations: size > 10_000 ? 20 : 50 },
        );

        provider.destroy();
      }
    });
  });

  describe("Memory Transport Throughput", () => {
    it("raw message throughput", async () => {
      const [a, b] = createMemoryTransportPair();
      const connA = new Connection({
        transports: [a],
        connect: false,
        batchIntervalMs: 0,
      });
      const connB = new Connection({
        transports: [b],
        connect: false,
        batchIntervalMs: 0,
      });

      await Promise.all([connA.connect(), connB.connect()]);

      const msg = new DocMessage("doc", { type: "sync-done" }, {}, false);
      const batchSize = 100;

      await benchBatch(
        `${batchSize} messages through memory transport`,
        async () => {
          for (let j = 0; j < batchSize; j++) {
            await connA.send(msg);
          }
          await flush();
        },
        { batchSize, iterations: 20 },
      );

      connA.destroy();
      connB.destroy();
    });
  });

  describe("Multi-Provider Sync", () => {
    it("two providers exchanging updates", async () => {
      const [t1client, t1server] = createMemoryTransportPair();
      const [t2client, t2server] = createMemoryTransportPair();

      const conn1 = new Connection({ transports: [t1client], connect: false, batchIntervalMs: 0 });
      const conn2 = new Connection({ transports: [t2client], connect: false, batchIntervalMs: 0 });

      await Promise.all([conn1.connect(), conn2.connect()]);

      const p1 = new Provider({
        connection: conn1,
        document: "shared-doc",
        encryptionKey: false,
        enableOfflinePersistence: false,
      });

      const p2 = new Provider({
        connection: conn2,
        document: "shared-doc",
        encryptionKey: false,
        enableOfflinePersistence: false,
      });

      const serverConn1 = new Connection({
        transports: [t1server],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn2 = new Connection({
        transports: [t2server],
        connect: false,
        batchIntervalMs: 0,
      });
      await Promise.all([serverConn1.connect(), serverConn2.connect()]);

      await sendSyncDone(serverConn1, "shared-doc");
      await sendSyncDone(serverConn2, "shared-doc");

      let i = 0;
      await bench(
        "p1 edit → relay → p2 apply",
        async () => {
          const sv = Y.encodeStateVector(p1.doc);
          p1.doc.getText("content").insert(i++ % 100, "a");
          const diff = Y.encodeStateAsUpdateV2(p1.doc, sv);
          const msg = new DocMessage(
            "shared-doc",
            { type: "update", update: { version: 2, data: wrapV2(diff) as UpdateV2 } },
            {},
            false,
          );
          await serverConn2.send(msg);
          await flush();
        },
        { iterations: 200 },
      );

      console.log(`    p1 doc length: ${p1.doc.getText("content").length}`);
      console.log(`    p2 doc length: ${p2.doc.getText("content").length}`);

      p1.destroy();
      p2.destroy();
    });
  });
});
