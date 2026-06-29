import { describe, it } from "bun:test";
import * as Y from "yjs";
import { InMemoryPubSub, DocMessage, type VersionedUpdate, type Update } from "teleportal";
import type { BinaryMessage, PubSubTopic } from "teleportal";
import { Connection } from "../src/providers/connection";
import { Provider } from "../src/providers/provider";
import { createMemoryTransportPair } from "../src/providers/transports/memory";
import {
  encodeContentEncryptedPayload,
  mergeContentEncryptedPayloads,
  type EncryptedUpdatePayload,
} from "../src/lib/protocol/encryption/encoding";
import { bench, formatBytes } from "./helpers";

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function makePayload(doc: Y.Doc, text: string, pos: number): EncryptedUpdatePayload {
  const sv = Y.encodeStateVector(doc);
  doc.getText("content").insert(pos, text);
  const diff = Y.encodeStateAsUpdateV2(doc, sv);
  return encodeContentEncryptedPayload({
    structureUpdate: diff,
    encryptedSidecars: [],
  }) as EncryptedUpdatePayload;
}

function makeBinaryMessage(docId: string, content: string): BinaryMessage {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const update = Y.encodeStateAsUpdateV2(doc);
  const payload = encodeContentEncryptedPayload({
    structureUpdate: update,
    encryptedSidecars: [],
  });
  const msg = new DocMessage(
    docId,
    {
      type: "update",
      update: { version: 2, data: payload as Update } as VersionedUpdate,
    },
    { userId: "bench-user", room: "bench", clientId: "bench-client" },
    false,
  );
  return msg.encoded;
}

describe("PubSub Benchmarks", () => {
  describe("publish with N subscribers", () => {
    for (const subscriberCount of [0, 1, 5, 10, 50]) {
      it(`${subscriberCount} subscribers`, async () => {
        const pubSub = new InMemoryPubSub();
        const topic = "document/bench-doc" as PubSubTopic;
        const binaryMsg = makeBinaryMessage("bench-doc", "hello world");

        for (let i = 0; i < subscriberCount; i++) {
          await pubSub.subscribe(topic, () => {});
        }

        console.log(
          `    ${subscriberCount} subscribers, msg: ${formatBytes(binaryMsg.byteLength)}`,
        );
        await bench(`publish to ${subscriberCount} subscribers`, async () => {
          await pubSub.publish(topic, binaryMsg, "node-1");
        });

        await pubSub[Symbol.asyncDispose]();
      });
    }
  });

  describe("publish by message size", () => {
    for (const { label, content } of [
      { label: "small (~100B)", content: "x".repeat(80) },
      { label: "medium (~1KB)", content: "x".repeat(900) },
      { label: "large (~10KB)", content: "x".repeat(9000) },
    ]) {
      it(label, async () => {
        const pubSub = new InMemoryPubSub();
        const topic = "document/bench-doc" as PubSubTopic;
        const binaryMsg = makeBinaryMessage("bench-doc", content);

        await pubSub.subscribe(topic, () => {});

        console.log(`    ${label}: ${formatBytes(binaryMsg.byteLength)}`);
        await bench(`publish (${label})`, async () => {
          await pubSub.publish(topic, binaryMsg, "node-1");
        });

        await pubSub[Symbol.asyncDispose]();
      });
    }
  });

  describe("subscribe + unsubscribe churn", () => {
    it("subscribe then immediately unsubscribe", async () => {
      const pubSub = new InMemoryPubSub();
      const topic = "document/churn-doc" as PubSubTopic;

      await bench("subscribe + unsubscribe", async () => {
        const unsub = await pubSub.subscribe(topic, () => {});
        await unsub();
      });

      await pubSub[Symbol.asyncDispose]();
    });
  });

  describe("multi-topic publish isolation", () => {
    it("publish to 1 of 100 topics", async () => {
      const pubSub = new InMemoryPubSub();
      const topics: PubSubTopic[] = [];
      for (let i = 0; i < 100; i++) {
        const topic = `document/doc-${i}` as PubSubTopic;
        topics.push(topic);
        await pubSub.subscribe(topic, () => {});
      }

      const targetTopic = topics[50];
      const binaryMsg = makeBinaryMessage("doc-50", "test");

      console.log("    100 topics, 1 subscriber each, publishing to 1 topic");
      await bench("publish to 1 of 100 topics", async () => {
        await pubSub.publish(targetTopic, binaryMsg, "node-1");
      });

      await pubSub[Symbol.asyncDispose]();
    });
  });
});

describe("Connection Batching Benchmarks", () => {
  describe("mergeContentEncryptedPayloads — core batching cost", () => {
    for (const batchSize of [2, 5, 10, 20, 50]) {
      it(`merge ${batchSize} payloads`, async () => {
        const doc = new Y.Doc();
        doc.getText("content").insert(0, "x".repeat(1000));
        const payloads: EncryptedUpdatePayload[] = [];
        for (let i = 0; i < batchSize; i++) {
          payloads.push(makePayload(doc, "y", i % 100));
        }

        const totalInputBytes = payloads.reduce((s, p) => s + (p as Uint8Array).byteLength, 0);
        const merged = mergeContentEncryptedPayloads(payloads);
        console.log(
          `    ${batchSize} payloads: input=${formatBytes(totalInputBytes)}, merged=${formatBytes((merged as Uint8Array).byteLength)}`,
        );

        await bench(`merge ${batchSize} payloads`, () => {
          mergeContentEncryptedPayloads(payloads);
        });
      });
    }
  });

  describe("batch merge amortization", () => {
    it("N×single vs 1×merged-N", async () => {
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "x".repeat(1000));
      const payloads: EncryptedUpdatePayload[] = [];
      for (let i = 0; i < 10; i++) {
        payloads.push(makePayload(doc, "z", i % 100));
      }

      const singleResult = await bench("encode 10 updates individually", () => {
        for (const p of payloads) {
          encodeContentEncryptedPayload({
            structureUpdate: p as Uint8Array,
            encryptedSidecars: [],
          });
        }
      });

      const mergeResult = await bench("merge 10 updates in one batch", () => {
        mergeContentEncryptedPayloads(payloads);
      });

      console.log(
        `    10×single: avg=${(singleResult.avgMs * 1000).toFixed(0)}μs vs 1×merge: avg=${(mergeResult.avgMs * 1000).toFixed(0)}μs`,
      );
    });
  });

  describe("concurrent multi-document batching", () => {
    it("interleaved updates across 5 documents", async () => {
      const DOC_COUNT = 5;
      const UPDATES_PER_DOC = 10;

      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const conn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 50,
      });
      await conn.connect();

      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      await serverConn.connect();

      const providers: Provider[] = [];
      for (let d = 0; d < DOC_COUNT; d++) {
        const provider = new Provider({
          connection: conn,
          document: `multi-doc-${d}`,
          encryptionKey: false,
          enableOfflinePersistence: false,
        });
        await serverConn.send(new DocMessage(`multi-doc-${d}`, { type: "sync-done" }, {}, false));
        providers.push(provider);
      }
      await flush();

      for (const p of providers) {
        p.doc.getText("content").insert(0, "x".repeat(200));
      }
      await flush();
      await new Promise((r) => setTimeout(r, 60));

      console.log(`    ${DOC_COUNT} docs, ${UPDATES_PER_DOC} updates each, interleaved`);

      await bench(
        `interleaved updates (${DOC_COUNT} docs × ${UPDATES_PER_DOC})`,
        async () => {
          for (let i = 0; i < UPDATES_PER_DOC; i++) {
            for (const p of providers) {
              p.doc.getText("content").insert(i % 50, "b");
            }
          }
          await new Promise((r) => setTimeout(r, 60));
        },
        { time: 1000, iterations: 10 },
      );

      for (const p of providers) {
        p.destroy({ destroyConnection: false, destroyDoc: false });
      }
      await new Promise((r) => setTimeout(r, 60));
      conn.destroy();
    });
  });
});
