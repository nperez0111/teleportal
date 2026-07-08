import { describe, it } from "bun:test";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness.js";
import {
  DocMessage,
  type AwarenessUpdateMessage,
  type ClientContext,
  type VersionedUpdate,
  type VersionedSyncStep2Update,
} from "teleportal";
import {
  encodeContentEncryptedPayload,
  mergeContentEncryptedPayloads,
  type EncryptedUpdatePayload,
} from "../src/lib/protocol/encryption/encoding";
import {
  stripContent,
  restoreContent,
  encodeSidecar,
  decodeSidecar,
  mergeSidecars,
  hashSidecar,
  compactSidecars,
  encryptUpdateContent,
  createKeyedTokenizer,
} from "../src/lib/protocol/encryption/content-cipher";
import { EncryptionClient } from "../src/transports/encrypted";
import { createEncryptionKey, type EncryptedBinary } from "../src/encryption-key";
import { DirectConnection as Connection } from "../src/providers/connection";
import { Provider } from "../src/providers/provider";
import { createMemoryTransportPair } from "../src/providers/transports/memory";
import { bench, createLargeDoc, formatBytes, flush } from "./helpers";

// ── Realistic content ──────────────────────────────────────────────────────

const PARAGRAPHS = [
  "The quick brown fox jumps over the lazy dog. This sentence contains every letter of the alphabet and has been used for centuries as a typographic test phrase.",
  "In the vast expanse of the digital universe, synchronization protocols weave invisible threads connecting disparate nodes. Each message carries not just data, but the promise of eventual consistency across all participants.",
  "Conflict-free replicated data types represent a fundamental shift in how we think about distributed state. Rather than preventing conflicts, CRDTs embrace concurrency by ensuring that all operations commute, producing identical results regardless of arrival order.",
  "End-to-end encryption ensures that only the communicating users can read the messages. Even the server facilitating the communication cannot decrypt the content, providing a strong guarantee of privacy and data sovereignty.",
  "Real-time collaborative editing requires careful orchestration of updates, acknowledgments, and state vectors. The challenge lies in maintaining responsiveness for the local user while ensuring eventual convergence with remote peers.",
];

const SENTENCES = [
  "Hello, world!",
  "The server processes each update atomically.",
  "Encryption adds roughly 28 bytes of overhead per sidecar.",
  "Users expect sub-100ms latency for keystroke propagation.",
  "Each Y.js document maintains a monotonically increasing logical clock per client.",
];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Capture an incremental update (not the full state) from a Y.Doc edit. */
function captureIncrementalUpdate(doc: Y.Doc, editFn: (doc: Y.Doc) => void): VersionedUpdate {
  let captured: Uint8Array | null = null;
  const handler = (update: Uint8Array) => {
    captured = update;
  };
  doc.on("updateV2", handler);
  editFn(doc);
  doc.off("updateV2", handler);
  return { version: 2, data: captured! } as VersionedUpdate;
}

function extractPayloadUpdate(msg: DocMessage<ClientContext>): VersionedUpdate {
  return (msg.payload as { update: VersionedUpdate }).update;
}

async function createEncryptionClientPair(docSize = 0) {
  const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
  const doc1 = new Y.Doc();
  const doc2 = new Y.Doc();
  if (docSize > 0) {
    const text = doc1.getText("content");
    const chunk = "x".repeat(Math.min(docSize, 1000));
    for (let i = 0; i < docSize; i += chunk.length) {
      text.insert(i, chunk.substring(0, Math.min(chunk.length, docSize - i)));
    }
    Y.applyUpdateV2(doc2, Y.encodeStateAsUpdateV2(doc1));
  }

  const client1 = new EncryptionClient({
    document: "bench-doc",
    ydoc: doc1,
    awareness: new Awareness(doc1),
    key,
  });
  const client2 = new EncryptionClient({
    document: "bench-doc",
    ydoc: doc2,
    awareness: new Awareness(doc2),
    key,
  });
  return { key, doc1, doc2, client1, client2 };
}

// ── Benchmarks ─────────────────────────────────────────────────────────────

describe("Client Encryption Pipeline Benchmarks", () => {
  // ── 1. Outbound: local edit → encrypted message ────────────────────────

  describe("Outbound: local edit → encrypted message", () => {
    it("onUpdate - keystroke edit", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "initial ");
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      await bench(
        "onUpdate (keystroke)",
        async () => {
          const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
            const t = d.getText("content");
            t.insert(t.length, "a");
          });
          await client.onUpdate(versionedUpdate);
        },
        { iterations: 200 },
      );
    });

    it("onUpdate - sentence edit", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      await bench(
        "onUpdate (sentence ~40 chars)",
        async () => {
          const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
            const t = d.getText("content");
            t.insert(t.length, SENTENCES[0]);
          });
          await client.onUpdate(versionedUpdate);
        },
        { iterations: 200 },
      );
    });

    it("onUpdate - paragraph edit", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      await bench(
        "onUpdate (paragraph ~200 chars)",
        async () => {
          const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
            const t = d.getText("content");
            t.insert(t.length, PARAGRAPHS[0]);
          });
          await client.onUpdate(versionedUpdate);
        },
        { iterations: 200 },
      );
    });

    it("onUpdate as document grows (1K → 50K chars)", async () => {
      for (const size of [1_000, 5_000, 10_000, 50_000]) {
        const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
        const doc = createLargeDoc(size);
        const client = new EncryptionClient({
          document: "bench-doc",
          ydoc: doc,
          awareness: new Awareness(doc),
          key,
        });

        const stateSize = Y.encodeStateAsUpdateV2(doc).byteLength;
        console.log(`    doc ${size} chars → state ${formatBytes(stateSize)}`);

        await bench(
          `onUpdate keystroke (doc=${size} chars)`,
          async () => {
            const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
              const t = d.getText("content");
              t.insert(t.length, "x");
            });
            await client.onUpdate(versionedUpdate);
          },
          { iterations: size > 10_000 ? 64 : 200 },
        );
      }
    });

    it("onUpdate - compaction spike vs normal edit", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "base");
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      // Accumulate sidecars to trigger compaction
      const threshold = EncryptionClient.COMPACTION_THRESHOLD;
      for (let i = 0; i < threshold + 5; i++) {
        const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
          d.getText("content").insert(d.getText("content").length, `edit-${i} `);
        });
        await client.onUpdate(versionedUpdate);
      }

      // Normal edit (no compaction pending — threshold was just cleared)
      await bench(
        "onUpdate (normal, post-compaction)",
        async () => {
          const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
            d.getText("content").insert(d.getText("content").length, "n");
          });
          await client.onUpdate(versionedUpdate);
        },
        { iterations: 200 },
      );
    });
  });

  // ── 2. Inbound: encrypted message → Y.Doc ─────────────────────────────

  describe("Inbound: encrypted message → Y.Doc", () => {
    it("handleUpdate - keystroke", async () => {
      const { client1, doc1 } = await createEncryptionClientPair(100);

      // Pre-generate an encrypted update from client1
      const versionedUpdate = captureIncrementalUpdate(doc1, (d) => {
        d.getText("content").insert(d.getText("content").length, "k");
      });
      const msg = (await client1.onUpdate(versionedUpdate)) as DocMessage<ClientContext>;
      const payload = extractPayloadUpdate(msg);

      await bench(
        "handleUpdate (keystroke)",
        async () => {
          const freshDoc = new Y.Doc();
          const freshClient = new EncryptionClient({
            document: "bench-doc",
            ydoc: freshDoc,
            awareness: new Awareness(freshDoc),
            key: client1.key,
          });
          await freshClient.handleUpdate(payload);
        },
        { iterations: 100 },
      );
    });

    it("handleUpdate - sentence", async () => {
      const { client1, doc1 } = await createEncryptionClientPair(100);

      const versionedUpdate = captureIncrementalUpdate(doc1, (d) => {
        d.getText("content").insert(d.getText("content").length, SENTENCES[2]);
      });
      const msg = (await client1.onUpdate(versionedUpdate)) as DocMessage<ClientContext>;
      const payload = extractPayloadUpdate(msg);

      await bench(
        "handleUpdate (sentence)",
        async () => {
          const freshDoc = new Y.Doc();
          const freshClient = new EncryptionClient({
            document: "bench-doc",
            ydoc: freshDoc,
            awareness: new Awareness(freshDoc),
            key: client1.key,
          });
          await freshClient.handleUpdate(payload);
        },
        { iterations: 100 },
      );
    });

    it("handleUpdate - burst of 50 rapid remote edits", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const senderDoc = new Y.Doc();
      senderDoc.getText("content").insert(0, "base");
      const sender = new EncryptionClient({
        document: "bench-doc",
        ydoc: senderDoc,
        awareness: new Awareness(senderDoc),
        key,
      });

      // Pre-generate 50 encrypted updates
      const payloads: VersionedUpdate[] = [];
      for (let i = 0; i < 50; i++) {
        const versionedUpdate = captureIncrementalUpdate(senderDoc, (d) => {
          d.getText("content").insert(d.getText("content").length, `w${i}`);
        });
        const msg = (await sender.onUpdate(versionedUpdate)) as DocMessage<ClientContext>;
        payloads.push(extractPayloadUpdate(msg));
      }

      await bench(
        "handleUpdate burst (50 remote edits)",
        async () => {
          const recvDoc = new Y.Doc();
          recvDoc.getText("content").insert(0, "base");
          const receiver = new EncryptionClient({
            document: "bench-doc",
            ydoc: recvDoc,
            awareness: new Awareness(recvDoc),
            key,
          });
          for (const p of payloads) {
            await receiver.handleUpdate(p);
          }
        },
        { iterations: 20 },
      );
    });
  });

  // ── 3. Initial sync & reconnect ───────────────────────────────────────

  describe("Initial sync & reconnect", () => {
    it("handleSyncStep1 - various doc sizes", async () => {
      for (const size of [100, 1_000, 5_000, 10_000]) {
        const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
        const doc = createLargeDoc(size);
        const client = new EncryptionClient({
          document: "bench-doc",
          ydoc: doc,
          awareness: new Awareness(doc),
          key,
        });

        // Simulate a remote peer requesting sync with an empty state vector
        const emptySv = Y.encodeStateVector(new Y.Doc());
        console.log(
          `    doc=${size} chars, update=${formatBytes(Y.encodeStateAsUpdateV2(doc).byteLength)}`,
        );

        await bench(
          `handleSyncStep1 (doc=${size} chars)`,
          async () => {
            await client.handleSyncStep1(emptySv);
          },
          { iterations: size > 5_000 ? 32 : 100 },
        );
      }
    });

    it("handleSyncStep2 - receiving full doc state", async () => {
      for (const size of [100, 1_000, 5_000]) {
        const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
        // Sender has the document
        const senderDoc = createLargeDoc(size);
        const sender = new EncryptionClient({
          document: "bench-doc",
          ydoc: senderDoc,
          awareness: new Awareness(senderDoc),
          key,
        });

        // Simulate sender producing a sync-step-2 response
        const emptySv = Y.encodeStateVector(new Y.Doc());
        const syncStep2Msg = await sender.handleSyncStep1(emptySv);
        const syncStep2Payload = (syncStep2Msg.payload as { update: VersionedSyncStep2Update })
          .update;

        await bench(
          `handleSyncStep2 (doc=${size} chars)`,
          async () => {
            const recvDoc = new Y.Doc();
            const receiver = new EncryptionClient({
              document: "bench-doc",
              ydoc: recvDoc,
              awareness: new Awareness(recvDoc),
              key,
            });
            await receiver.handleSyncStep2(syncStep2Payload);
          },
          { iterations: size > 2_000 ? 32 : 100 },
        );
      }
    });

    it("offline reconnect - sync diff after local edits", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = createLargeDoc(5_000);
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      // Simulate offline edits
      for (let i = 0; i < 20; i++) {
        doc.getText("content").insert(doc.getText("content").length, ` offline-edit-${i}`);
      }

      // Remote peer has the pre-offline state (empty for worst case)
      const remoteSv = Y.encodeStateVector(new Y.Doc());
      const stateSize = Y.encodeStateAsUpdateV2(doc).byteLength;
      console.log(`    doc state after offline edits: ${formatBytes(stateSize)}`);

      await bench(
        "handleSyncStep1 (reconnect after 20 offline edits, 5K doc)",
        async () => {
          await client.handleSyncStep1(remoteSv);
        },
        { iterations: 32 },
      );
    });
  });

  // ── 4. Awareness ──────────────────────────────────────────────────────

  describe("Awareness", () => {
    it("encrypt awareness update (onAwarenessUpdate)", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness,
        key,
      });

      awareness.setLocalState({ cursor: { anchor: 0, head: 5 }, user: { name: "test" } });
      const awarenessUpdate = encodeAwarenessUpdate(awareness, [
        awareness.clientID,
      ]) as AwarenessUpdateMessage;

      await bench(
        "onAwarenessUpdate (encrypt)",
        async () => {
          await client.onAwarenessUpdate(awarenessUpdate);
        },
        { iterations: 500 },
      );
    });

    it("decrypt awareness update (handleAwarenessUpdate)", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness,
        key,
      });

      awareness.setLocalState({ cursor: { anchor: 10, head: 20 }, user: { name: "peer" } });
      const awarenessUpdate = encodeAwarenessUpdate(awareness, [
        awareness.clientID,
      ]) as AwarenessUpdateMessage;
      const encrypted = (await client.encryptUpdate(awarenessUpdate)) as AwarenessUpdateMessage;

      await bench(
        "handleAwarenessUpdate (decrypt)",
        async () => {
          const freshDoc = new Y.Doc();
          const freshAwareness = new Awareness(freshDoc);
          const freshClient = new EncryptionClient({
            document: "bench-doc",
            ydoc: freshDoc,
            awareness: freshAwareness,
            key,
          });
          await freshClient.handleAwarenessUpdate(encrypted);
        },
        { iterations: 200 },
      );
    });
  });

  // ── 5. Message wire encoding ──────────────────────────────────────────

  describe("Message wire encoding", () => {
    it("DocMessage encode + decode", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "hello world");
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
        d.getText("content").insert(d.getText("content").length, " more text");
      });
      const msg = (await client.onUpdate(versionedUpdate)) as DocMessage<ClientContext>;

      await bench(
        "DocMessage.encode()",
        () => {
          msg.resetEncoded();
          void msg.encoded;
        },
        { iterations: 1000 },
      );
    });

    it("DocMessage.id (SHA-256)", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "test content for id hash");
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
        d.getText("content").insert(d.getText("content").length, " extra");
      });
      const msg = (await client.onUpdate(versionedUpdate)) as DocMessage<ClientContext>;

      await bench(
        "DocMessage.id (SHA-256 hash)",
        () => {
          msg.resetEncoded();
          void msg.id;
        },
        { iterations: 1000 },
      );
    });
  });

  // ── 6. Connection batching ────────────────────────────────────────────

  describe("Connection batching", () => {
    it("mergeContentEncryptedPayloads by batch size", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: new Awareness(doc),
        key,
      });

      for (const batchSize of [2, 5, 10, 25]) {
        // Pre-generate payloads
        const payloads: EncryptedUpdatePayload[] = [];
        for (let i = 0; i < batchSize; i++) {
          const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
            d.getText("content").insert(d.getText("content").length, `batch-${i} `);
          });
          const msg = (await client.onUpdate(versionedUpdate)) as DocMessage<ClientContext>;
          payloads.push(extractPayloadUpdate(msg).data as EncryptedUpdatePayload);
        }

        await bench(
          `mergeContentEncryptedPayloads (batch=${batchSize})`,
          () => {
            mergeContentEncryptedPayloads(payloads);
          },
          { iterations: batchSize > 10 ? 64 : 200 },
        );
      }
    });
  });

  // ── 7. Y.js primitives (baseline, no encryption) ─────────────────────

  describe("Y.js primitives (baseline)", () => {
    it("encodeStateAsUpdateV2", async () => {
      for (const size of [100, 1_000, 10_000]) {
        const doc = createLargeDoc(size);
        const stateSize = Y.encodeStateAsUpdateV2(doc).byteLength;
        console.log(`    doc=${size} chars, v2 state=${formatBytes(stateSize)}`);

        await bench(
          `encodeStateAsUpdateV2 (${size} chars)`,
          () => {
            Y.encodeStateAsUpdateV2(doc);
          },
          { iterations: size > 5_000 ? 64 : 500 },
        );
      }
    });

    it("applyUpdateV2", async () => {
      for (const size of [100, 1_000, 10_000]) {
        const sourceDoc = createLargeDoc(size);
        const update = Y.encodeStateAsUpdateV2(sourceDoc);

        await bench(
          `applyUpdateV2 (${size} chars)`,
          () => {
            const targetDoc = new Y.Doc();
            Y.applyUpdateV2(targetDoc, update);
          },
          { iterations: size > 5_000 ? 64 : 500 },
        );
      }
    });

    it("mergeUpdatesV2", async () => {
      for (const count of [2, 5, 10, 50]) {
        const doc = new Y.Doc();
        const updates: Uint8Array[] = [];
        for (let i = 0; i < count; i++) {
          doc.getText("content").insert(doc.getText("content").length, `update-${i} `);
          updates.push(Y.encodeStateAsUpdateV2(doc));
        }

        await bench(
          `mergeUpdatesV2 (${count} updates)`,
          () => {
            Y.mergeUpdatesV2(updates);
          },
          { iterations: count > 20 ? 32 : 200 },
        );
      }
    });

    it("convertUpdateFormatV1ToV2", async () => {
      for (const size of [100, 1_000, 5_000]) {
        const doc = createLargeDoc(size);
        const v1Update = Y.encodeStateAsUpdate(doc);
        console.log(`    v1=${formatBytes(v1Update.byteLength)}`);

        await bench(
          `convertUpdateFormatV1ToV2 (${size} chars)`,
          () => {
            Y.convertUpdateFormatV1ToV2(v1Update);
          },
          { iterations: size > 2_000 ? 64 : 500 },
        );
      }
    });
  });

  // ── 8. Encryption internals ───────────────────────────────────────────

  describe("Encryption internals", () => {
    it("stripContent + restoreContent round trip", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      const tokenizer = createKeyedTokenizer(rawKey);

      for (const size of [100, 1_000, 5_000]) {
        const doc = createLargeDoc(size);
        const update = Y.encodeStateAsUpdateV2(doc);
        console.log(`    doc=${size} chars, update=${formatBytes(update.byteLength)}`);

        await bench(
          `stripContent (${size} chars)`,
          () => {
            stripContent(update, 2, tokenizer);
          },
          { iterations: size > 2_000 ? 64 : 200 },
        );

        const { update: structureUpdate, sidecar } = stripContent(update, 2, tokenizer);

        await bench(
          `restoreContent (${size} chars)`,
          () => {
            restoreContent(structureUpdate, sidecar);
          },
          { iterations: size > 2_000 ? 64 : 200 },
        );
      }
    });

    it("compaction cost breakdown", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "base");

      // Generate encrypted sidecars
      const sidecars: EncryptedBinary[] = [];
      for (let i = 0; i < 30; i++) {
        const versionedUpdate = captureIncrementalUpdate(doc, (d) => {
          d.getText("content").insert(d.getText("content").length, `c${i} `);
        });
        const { encryptedSidecar } = await encryptUpdateContent(
          key,
          versionedUpdate.data,
          versionedUpdate.version as 1 | 2,
        );
        sidecars.push(encryptedSidecar);
      }

      for (const count of [5, 10, 25]) {
        const subset = sidecars.slice(0, count);

        await bench(
          `compactSidecars (${count} sidecars)`,
          async () => {
            await compactSidecars(key, subset);
          },
          { iterations: 32 },
        );
      }
    });

    it("sidecar encode/decode by entry count", async () => {
      for (const entryCount of [1, 10, 50, 100]) {
        const entries = Array.from({ length: entryCount }, (_, i) => ({
          clientId: 1,
          clock: i,
          contentRef: 4, // CONTENT_STRING
          data: new TextEncoder().encode(`entry-${i}-content`),
          itemLength: 1,
        }));
        const dictionary = new Map([["tok1", "original1"]]);
        const sidecar = { entries, dictionary };
        const encoded = encodeSidecar(sidecar);
        console.log(`    ${entryCount} entries → ${formatBytes(encoded.byteLength)}`);

        await bench(
          `encodeSidecar (${entryCount} entries)`,
          () => {
            encodeSidecar(sidecar);
          },
          { iterations: entryCount > 50 ? 200 : 1000 },
        );

        await bench(
          `decodeSidecar (${entryCount} entries)`,
          () => {
            decodeSidecar(encoded);
          },
          { iterations: entryCount > 50 ? 200 : 1000 },
        );
      }
    });

    it("hashSidecar", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "hash test content");
      const { encryptedSidecar } = await encryptUpdateContent(key, Y.encodeStateAsUpdateV2(doc), 2);

      await bench(
        "hashSidecar (SHA-256)",
        async () => {
          await hashSidecar(encryptedSidecar);
        },
        { iterations: 2000 },
      );
    });

    it("encodeContentEncryptedPayload by sidecar count", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "payload test");
      const structureUpdate = Y.encodeStateAsUpdateV2(doc);

      // Pre-generate encrypted sidecars
      const allSidecars: EncryptedBinary[] = [];
      for (let i = 0; i < 10; i++) {
        doc.getText("content").insert(doc.getText("content").length, ` extra-${i}`);
        const { encryptedSidecar } = await encryptUpdateContent(
          key,
          Y.encodeStateAsUpdateV2(doc),
          2,
        );
        allSidecars.push(encryptedSidecar);
      }

      for (const count of [1, 3, 5, 10]) {
        const sidecars = allSidecars.slice(0, count);

        await bench(
          `encodeContentEncryptedPayload (${count} sidecars)`,
          () => {
            encodeContentEncryptedPayload({
              structureUpdate,
              encryptedSidecars: sidecars,
            });
          },
          { iterations: 500 },
        );
      }
    });

    it("mergeSidecars (decoded, in-memory)", async () => {
      for (const count of [2, 5, 10]) {
        const sidecarsToMerge = Array.from({ length: count }, (_, i) => ({
          entries: Array.from({ length: 5 }, (_, j) => ({
            clientId: i,
            clock: j,
            contentRef: 4,
            data: new TextEncoder().encode(`content-${i}-${j}`),
            itemLength: 1,
          })),
          dictionary: new Map([[`tok-${i}`, `orig-${i}`]]),
        }));

        await bench(
          `mergeSidecars (${count} sidecars, ${count * 5} entries)`,
          () => {
            mergeSidecars(sidecarsToMerge);
          },
          { iterations: 1000 },
        );
      }
    });
  });

  // ── 9. Provider end-to-end ────────────────────────────────────────────

  describe("Provider end-to-end", () => {
    it("provider creation (encrypted vs plaintext)", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      await bench(
        "Provider creation (encrypted)",
        () => {
          const [clientTransport] = createMemoryTransportPair();
          // connect: false avoids async #init, keeping the benchmark synchronous
          const conn = new Connection({
            transports: [clientTransport],
            connect: false,
            batchIntervalMs: 0,
          });
          const provider = new Provider({
            connection: conn,
            document: "bench-doc",
            encryptionKey: key,
            enableOfflinePersistence: false,
          });
          provider.destroy({ destroyConnection: false });
          conn.destroy();
        },
        { iterations: 100 },
      );

      await bench(
        "Provider creation (plaintext)",
        () => {
          const [clientTransport] = createMemoryTransportPair();
          const conn = new Connection({
            transports: [clientTransport],
            connect: false,
            batchIntervalMs: 0,
          });
          const provider = new Provider({
            connection: conn,
            document: "bench-doc",
            encryptionKey: false,
            enableOfflinePersistence: false,
          });
          provider.destroy({ destroyConnection: false });
          conn.destroy();
        },
        { iterations: 100 },
      );
    });

    it("local edit → outbound (encrypted vs plaintext)", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      // Encrypted provider
      const [ct1] = createMemoryTransportPair();
      const conn1 = new Connection({
        transports: [ct1],
        connect: false,
        batchIntervalMs: 0,
      });
      await conn1.connect();
      const encProvider = new Provider({
        connection: conn1,
        document: "bench-enc",
        encryptionKey: key,
        enableOfflinePersistence: false,
      });

      await bench(
        "local edit → outbound (encrypted)",
        async () => {
          encProvider.doc.getText("content").insert(encProvider.doc.getText("content").length, "x");
          await flush();
        },
        { iterations: 200 },
      );
      encProvider.destroy();

      // Plaintext provider
      const [ct2] = createMemoryTransportPair();
      const conn2 = new Connection({
        transports: [ct2],
        connect: false,
        batchIntervalMs: 0,
      });
      await conn2.connect();
      const ptProvider = new Provider({
        connection: conn2,
        document: "bench-pt",
        encryptionKey: false,
        enableOfflinePersistence: false,
      });

      await bench(
        "local edit → outbound (plaintext)",
        async () => {
          ptProvider.doc.getText("content").insert(ptProvider.doc.getText("content").length, "x");
          await flush();
        },
        { iterations: 200 },
      );
      ptProvider.destroy();
    });

    it("remote edit → apply (encrypted)", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      // Set up a sender to produce encrypted messages
      const senderDoc = new Y.Doc();
      senderDoc.getText("content").insert(0, "base");
      const sender = new EncryptionClient({
        document: "bench-doc",
        ydoc: senderDoc,
        awareness: new Awareness(senderDoc),
        key,
      });

      // Pre-generate an encrypted update
      const versionedUpdate = captureIncrementalUpdate(senderDoc, (d) => {
        d.getText("content").insert(d.getText("content").length, " remote edit");
      });
      const encMsg = (await sender.onUpdate(versionedUpdate)) as DocMessage<ClientContext>;

      // Receiver applies it
      const [ct] = createMemoryTransportPair();
      const conn = new Connection({
        transports: [ct],
        connect: false,
        batchIntervalMs: 0,
      });
      await conn.connect();

      await bench(
        "remote edit → apply (encrypted provider)",
        async () => {
          const recvDoc = new Y.Doc();
          recvDoc.getText("content").insert(0, "base");
          const provider = new Provider({
            connection: conn,
            document: "bench-doc",
            encryptionKey: key,
            enableOfflinePersistence: false,
            ydoc: recvDoc,
          });
          // Simulate receiving the encrypted message through the transport sink
          await provider.transport.write(encMsg as any);
          await flush();
          provider.destroy({ destroyConnection: false });
        },
        { iterations: 64 },
      );
      conn.destroy();
    });

    it("two encrypted providers syncing", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      // Create a pair of connected memory transports
      const [ct1, ct2] = createMemoryTransportPair();
      const conn1 = new Connection({
        transports: [ct1],
        connect: false,
        batchIntervalMs: 0,
      });
      const conn2 = new Connection({
        transports: [ct2],
        connect: false,
        batchIntervalMs: 0,
      });
      await Promise.all([conn1.connect(), conn2.connect()]);

      const provider1 = new Provider({
        connection: conn1,
        document: "bench-sync",
        encryptionKey: key,
        enableOfflinePersistence: false,
      });
      const provider2 = new Provider({
        connection: conn2,
        document: "bench-sync",
        encryptionKey: key,
        enableOfflinePersistence: false,
      });

      await bench(
        "two encrypted providers: edit + sync",
        async () => {
          provider1.doc.getText("content").insert(provider1.doc.getText("content").length, "s");
          await flush();
          await new Promise((r) => setTimeout(r, 0));
        },
        { iterations: 100 },
      );

      provider1.destroy();
      provider2.destroy();
    });

    it("encrypted edit scaling with document size", async () => {
      const keyResolver = createEncryptionKey(); const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      for (const size of [100, 1_000, 10_000]) {
        const [ct] = createMemoryTransportPair();
        const conn = new Connection({
          transports: [ct],
          connect: false,
          batchIntervalMs: 0,
        });
        await conn.connect();

        const doc = createLargeDoc(size);
        const provider = new Provider({
          connection: conn,
          document: `bench-scale-${size}`,
          encryptionKey: key,
          enableOfflinePersistence: false,
          ydoc: doc,
        });

        console.log(
          `    doc=${size} chars, state=${formatBytes(Y.encodeStateAsUpdateV2(doc).byteLength)}`,
        );

        await bench(
          `encrypted keystroke (doc=${size} chars)`,
          async () => {
            provider.doc.getText("content").insert(provider.doc.getText("content").length, "z");
            await flush();
          },
          { iterations: size > 5_000 ? 64 : 200 },
        );

        provider.destroy();
      }
    });
  });
});
