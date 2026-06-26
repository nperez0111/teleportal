import { describe, it, beforeEach } from "bun:test";
import * as Y from "yjs";
import { MemoryDocumentStorage } from "../src/storage/in-memory/document-storage";
import { VirtualStorage } from "../src/storage/virtual-storage";
import { encodeContentEncryptedPayload } from "../src/lib/protocol/encryption/encoding";
import type { VersionedUpdate, Update, StateVector } from "teleportal";
import {
  decodeContentEncryptedPayload,
  type EncryptedUpdatePayload,
} from "../src/lib/protocol/encryption/encoding";
import {
  buildSidecarIndexFromUpdateMeta,
} from "../src/lib/protocol/encryption/content-cipher";
import { bench, benchBatch, createLargeDoc, formatBytes } from "./helpers";

function wrapUpdate(rawV2: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: rawV2,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

function makeUpdate(content: string): VersionedUpdate {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return wrapUpdate(Y.encodeStateAsUpdateV2(doc));
}

function makeIncrementalUpdate(doc: Y.Doc, text: string, pos: number): VersionedUpdate {
  const sv = Y.encodeStateVector(doc);
  doc.getText("content").insert(pos, text);
  const diff = Y.encodeStateAsUpdateV2(doc, sv);
  return wrapUpdate(diff);
}

describe("Storage Benchmarks", () => {
  describe("MemoryDocumentStorage", () => {
    let storage: MemoryDocumentStorage;

    beforeEach(() => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      storage = new MemoryDocumentStorage(false);
    });

    it("handleUpdate - single small update", async () => {
      const update = makeUpdate("hello world");
      await bench(
        "handleUpdate (small)",
        () => storage.handleUpdate(`doc-${Math.random()}`, update),
        { iterations: 1000 },
      );
    });

    it("handleUpdate - incremental updates to same doc", async () => {
      const doc = new Y.Doc();
      let i = 0;
      await bench(
        "handleUpdate (incremental, same doc)",
        () => {
          const update = makeIncrementalUpdate(doc, "x", i++ % 100);
          return storage.handleUpdate("bench-doc", update);
        },
        { iterations: 500 },
      );
    });

    it("handleUpdate - large update", async () => {
      const largeDoc = createLargeDoc(10_000);
      const update = wrapUpdate(Y.encodeStateAsUpdateV2(largeDoc));
      console.log(`    update size: ${formatBytes(update.data.byteLength)}`);
      await bench(
        "handleUpdate (10K chars)",
        () => storage.handleUpdate(`doc-${Math.random()}`, update),
        { iterations: 100 },
      );
    });

    it("handleSyncStep1 - empty doc", async () => {
      const sv = Y.encodeStateVector(new Y.Doc()) as StateVector;
      await bench("handleSyncStep1 (empty doc)", () => storage.handleSyncStep1("empty-doc", sv), {
        iterations: 1000,
      });
    });

    it("handleSyncStep1 - doc with content", async () => {
      const update = wrapUpdate(Y.encodeStateAsUpdateV2(createLargeDoc(1_000)));
      await storage.handleUpdate("full-doc", update);

      const sv = Y.encodeStateVector(new Y.Doc()) as StateVector;
      await bench("handleSyncStep1 (1K char doc)", () => storage.handleSyncStep1("full-doc", sv), {
        iterations: 500,
      });
    });

    it("handleSyncStep1 - large doc with partial sync", async () => {
      const update = wrapUpdate(Y.encodeStateAsUpdateV2(createLargeDoc(50_000)));
      await storage.handleUpdate("large-doc", update);

      const clientDoc = new Y.Doc();
      Y.applyUpdateV2(clientDoc, Y.encodeStateAsUpdateV2(createLargeDoc(25_000)));
      const sv = Y.encodeStateVector(clientDoc) as StateVector;
      await bench(
        "handleSyncStep1 (50K doc, partial sync)",
        () => storage.handleSyncStep1("large-doc", sv),
        { iterations: 100 },
      );
    });

    it("getDocument", async () => {
      const update = wrapUpdate(Y.encodeStateAsUpdateV2(createLargeDoc(5_000)));
      await storage.handleUpdate("get-doc", update);

      await bench("getDocument (5K chars)", () => storage.getDocument("get-doc"), {
        iterations: 1000,
      });
    });

    it("writeDocumentMetadata + getDocumentMetadata", async () => {
      const metadata = {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: false,
      };
      await bench(
        "write+get metadata",
        async () => {
          await storage.writeDocumentMetadata("meta-doc", metadata);
          await storage.getDocumentMetadata("meta-doc");
        },
        { iterations: 1000 },
      );
    });

    it("many documents - create throughput", async () => {
      const update = makeUpdate("document content here");
      let docNum = 0;
      await benchBatch(
        "create 100 documents",
        async () => {
          for (let j = 0; j < 100; j++) {
            await storage.handleUpdate(`batch-doc-${docNum++}`, update);
          }
        },
        { batchSize: 100, iterations: 20 },
      );
    });
  });

  describe("VirtualStorage (write batching)", () => {
    it("handleUpdate - buffered writes vs direct", async () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.attributionMaps.clear();

      const inner = new MemoryDocumentStorage(false);
      const virtual = new VirtualStorage(inner, {
        batchMaxSize: 50,
        batchWaitMs: 1,
      });

      const doc = new Y.Doc();
      let i = 0;
      await bench(
        "VirtualStorage handleUpdate (buffered)",
        async () => {
          const update = makeIncrementalUpdate(doc, "x", i++ % 100);
          await virtual.handleUpdate("virtual-doc", update);
        },
        { iterations: 200, warmup: 5 },
      );

      await new Promise((r) => setTimeout(r, 5));
    });
  });

  describe("Y.js encoding overhead", () => {
    it("encodeStateAsUpdateV2 - various sizes", async () => {
      for (const size of [100, 1_000, 10_000, 50_000]) {
        const doc = createLargeDoc(size);
        await bench(
          `encodeStateAsUpdateV2 (${size} chars)`,
          () => {
            Y.encodeStateAsUpdateV2(doc);
          },
          { iterations: size > 10_000 ? 50 : 200 },
        );
        const encoded = Y.encodeStateAsUpdateV2(doc);
        console.log(`    encoded size: ${formatBytes(encoded.byteLength)}`);
      }
    });

    it("mergeUpdatesV2", async () => {
      const doc = new Y.Doc();
      const updates: Uint8Array[] = [];
      for (let i = 0; i < 100; i++) {
        const sv = Y.encodeStateVector(doc);
        doc.getText("content").insert(i, `char-${i}-`);
        updates.push(Y.encodeStateAsUpdateV2(doc, sv));
      }

      await bench(
        "mergeUpdatesV2 (100 updates)",
        () => {
          Y.mergeUpdatesV2(updates);
        },
        { iterations: 200 },
      );
    });

    it("diffUpdateV2", async () => {
      const doc = createLargeDoc(10_000);
      const fullUpdate = Y.encodeStateAsUpdateV2(doc);
      const partialDoc = createLargeDoc(5_000);
      const sv = Y.encodeStateVector(partialDoc);

      await bench(
        "diffUpdateV2 (10K doc, 50% diff)",
        () => {
          Y.diffUpdateV2(fullUpdate, sv);
        },
        { iterations: 200 },
      );
    });

    it("applyUpdateV2", async () => {
      const sourceDoc = createLargeDoc(5_000);
      const update = Y.encodeStateAsUpdateV2(sourceDoc);

      await bench(
        "applyUpdateV2 (5K chars)",
        () => {
          const doc = new Y.Doc();
          Y.applyUpdateV2(doc, update);
        },
        { iterations: 200 },
      );
    });
  });

  describe("handleUpdate sub-system overhead", () => {
    it("parseUpdateMetaV2 — cost that's skipped for unencrypted", async () => {
      for (const size of [100, 1_000, 10_000]) {
        const doc = createLargeDoc(size);
        const update = Y.encodeStateAsUpdateV2(doc);
        await bench(
          `parseUpdateMetaV2 (${size} chars)`,
          () => { Y.parseUpdateMetaV2(update); },
          { iterations: size > 5_000 ? 100 : 500 },
        );
      }
    });

    it("parseUpdateMetaV2 + buildSidecarIndex — skipped for unencrypted", async () => {
      const doc = createLargeDoc(1_000);
      const update = Y.encodeStateAsUpdateV2(doc);
      await bench(
        "parseUpdateMetaV2 + buildSidecarIndex (1K)",
        () => {
          const meta = Y.parseUpdateMetaV2(update);
          buildSidecarIndexFromUpdateMeta(meta);
        },
        { iterations: 500 },
      );
    });

    it("decodeContentEncryptedPayload — per-update envelope cost", async () => {
      for (const size of [100, 1_000, 10_000]) {
        const doc = createLargeDoc(size);
        const vUpdate = wrapUpdate(Y.encodeStateAsUpdateV2(doc));
        await bench(
          `decodeContentEncryptedPayload (${size} chars)`,
          () => { decodeContentEncryptedPayload(vUpdate.data as EncryptedUpdatePayload); },
          { iterations: size > 5_000 ? 200 : 1000 },
        );
      }
    });

    it("handleUpdate breakdown — incremental update on growing doc", async () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      const storage = new MemoryDocumentStorage(false);

      const doc = new Y.Doc();
      // Pre-populate with 500 chars so we measure steady-state cost
      for (let i = 0; i < 500; i++) {
        doc.getText("content").insert(i, "x");
      }
      const fullUpdate = wrapUpdate(Y.encodeStateAsUpdateV2(doc));
      await storage.handleUpdate("breakdown-doc", fullUpdate);

      let j = 0;
      await bench(
        "handleUpdate incremental (500-char doc, steady state)",
        () => {
          const update = makeIncrementalUpdate(doc, "y", j++ % 100);
          return storage.handleUpdate("breakdown-doc", update);
        },
        { iterations: 300 },
      );

      // Breakdown: what does mergeUpdatesV2 cost alone at this doc size?
      const existing = Y.encodeStateAsUpdateV2(doc);
      const sv = Y.encodeStateVector(doc);
      doc.getText("content").insert(0, "z");
      const incremental = Y.encodeStateAsUpdateV2(doc, sv);

      await bench(
        "mergeUpdatesV2 alone (500-char base + 1 char)",
        () => { Y.mergeUpdatesV2([existing, incremental]); },
        { iterations: 500 },
      );
    });
  });
});
