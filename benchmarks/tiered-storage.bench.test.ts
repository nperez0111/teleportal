import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import * as Y from "yjs";
import { createStorage, type Storage } from "unstorage";
import fsDriver from "unstorage/drivers/fs";
import { MemoryDocumentStorage } from "../src/storage/in-memory/document-storage";
import { UnstorageDocumentStorage } from "../src/storage/unstorage/document-storage";
import { TieredDocumentStorage } from "../src/storage/tiered/document-storage";
import { encodeContentEncryptedPayload } from "../src/lib/protocol/encryption/encoding";
import type { VersionedUpdate, Update, StateVector } from "teleportal";
import { bench, createLargeDoc, formatBytes, formatDuration } from "./helpers";
import type { AbstractDocumentStorage } from "../src/storage/document-storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  return wrapUpdate(Y.encodeStateAsUpdateV2(doc, sv));
}

// ── Backend factories ────────────────────────────────────────────────────────

type BackendSetup = {
  name: string;
  make: () => AbstractDocumentStorage;
  cleanup: () => Promise<void>;
};

let tmpDir: string;
const openStorages: Storage[] = [];

function makeBackends(): BackendSetup[] {
  return [
    {
      name: "Memory",
      make: () => {
        MemoryDocumentStorage.docs.clear();
        MemoryDocumentStorage.attributionMaps.clear();
        return new MemoryDocumentStorage(false);
      },
      cleanup: async () => {
        MemoryDocumentStorage.docs.clear();
        MemoryDocumentStorage.attributionMaps.clear();
      },
    },
    {
      name: "Unstorage (fs)",
      make: () => {
        const store = createStorage({ driver: fsDriver({ base: tmpDir }) });
        openStorages.push(store);
        return new UnstorageDocumentStorage(store, { encrypted: false });
      },
      cleanup: async () => {
        await Promise.all(openStorages.splice(0).map((s) => s.dispose()));
      },
    },
    {
      name: "Tiered (mem+fs)",
      make: () => {
        MemoryDocumentStorage.docs.clear();
        MemoryDocumentStorage.attributionMaps.clear();
        const store = createStorage({ driver: fsDriver({ base: tmpDir }) });
        openStorages.push(store);
        return new TieredDocumentStorage(
          new MemoryDocumentStorage(false),
          new UnstorageDocumentStorage(store, { encrypted: false }),
          { persistIntervalMs: 60_000 },
        );
      },
      cleanup: async () => {
        MemoryDocumentStorage.docs.clear();
        MemoryDocumentStorage.attributionMaps.clear();
        await Promise.all(openStorages.splice(0).map((s) => s.dispose()));
      },
    },
  ];
}

// ── Benchmarks ───────────────────────────────────────────────────────────────

describe("Tiered Storage Benchmarks", () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "teleportal-bench-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("handleUpdate — small update (new doc each time)", () => {
    for (const backend of makeBackends()) {
      it(backend.name, async () => {
        const storage = backend.make();
        const update = makeUpdate("hello world");
        let i = 0;
        await bench(
          backend.name,
          () => storage.handleUpdate(`doc-${i++}`, update),
          { iterations: 500 },
        );
        await backend.cleanup();
      });
    }
  });

  describe("handleUpdate — incremental updates (same doc)", () => {
    for (const backend of makeBackends()) {
      it(backend.name, async () => {
        const storage = backend.make();
        const doc = new Y.Doc();
        let i = 0;
        await bench(
          backend.name,
          () => {
            const update = makeIncrementalUpdate(doc, "x", i++ % 100);
            return storage.handleUpdate("bench-doc", update);
          },
          { iterations: 300 },
        );
        await backend.cleanup();
      });
    }
  });

  describe("handleUpdate — large update (10K chars)", () => {
    for (const backend of makeBackends()) {
      it(backend.name, async () => {
        const storage = backend.make();
        const largeDoc = createLargeDoc(10_000);
        const update = wrapUpdate(Y.encodeStateAsUpdateV2(largeDoc));
        console.log(`    update size: ${formatBytes(update.data.byteLength)}`);
        let i = 0;
        await bench(
          backend.name,
          () => storage.handleUpdate(`doc-${i++}`, update),
          { iterations: 100 },
        );
        await backend.cleanup();
      });
    }
  });

  describe("getDocument — 5K char doc", () => {
    for (const backend of makeBackends()) {
      it(backend.name, async () => {
        const storage = backend.make();
        const update = wrapUpdate(Y.encodeStateAsUpdateV2(createLargeDoc(5_000)));
        await storage.handleUpdate("get-doc", update);
        await bench(
          backend.name,
          () => storage.getDocument("get-doc"),
          { iterations: 500 },
        );
        await backend.cleanup();
      });
    }
  });

  describe("handleSyncStep1 — 1K char doc, empty client", () => {
    for (const backend of makeBackends()) {
      it(backend.name, async () => {
        const storage = backend.make();
        const update = wrapUpdate(Y.encodeStateAsUpdateV2(createLargeDoc(1_000)));
        await storage.handleUpdate("sync-doc", update);
        const sv = Y.encodeStateVector(new Y.Doc()) as StateVector;
        await bench(
          backend.name,
          () => storage.handleSyncStep1("sync-doc", sv),
          { iterations: 500 },
        );
        await backend.cleanup();
      });
    }
  });

  describe("write-then-read cycle — simulating real usage", () => {
    for (const backend of makeBackends()) {
      it(backend.name, async () => {
        const storage = backend.make();
        const doc = new Y.Doc();
        const sv = Y.encodeStateVector(new Y.Doc()) as StateVector;
        let i = 0;
        await bench(
          backend.name,
          async () => {
            const update = makeIncrementalUpdate(doc, "x", i++ % 100);
            await storage.handleUpdate("cycle-doc", update);
            if (i % 10 === 0) {
              await storage.handleSyncStep1("cycle-doc", sv);
            }
          },
          { iterations: 300 },
        );
        await backend.cleanup();
      });
    }
  });

  describe("write burst then flush — tiered-specific", () => {
    it("100 updates then flush", async () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      const store = createStorage({ driver: fsDriver({ base: tmpDir }) });

      const fast = new MemoryDocumentStorage(false);
      const slow = new UnstorageDocumentStorage(store, { encrypted: false });
      const tiered = new TieredDocumentStorage(fast, slow, {
        persistIntervalMs: 60_000,
      });

      const doc = new Y.Doc();
      let i = 0;

      // Measure: 100 fast writes + 1 flush
      await bench(
        "100 writes + flush",
        async () => {
          const docId = `burst-${i++}`;
          for (let j = 0; j < 100; j++) {
            const update = makeIncrementalUpdate(doc, "x", j % 50);
            await tiered.handleUpdate(docId, update);
          }
          await tiered.flush(docId);
        },
        { iterations: 20 },
      );

      // Compare: 100 direct writes to unstorage
      MemoryDocumentStorage.docs.clear();
      i = 0;
      await bench(
        "100 writes direct to unstorage (no tier)",
        async () => {
          const docId = `direct-${i++}`;
          for (let j = 0; j < 100; j++) {
            const update = makeIncrementalUpdate(doc, "x", j % 50);
            await slow.handleUpdate(docId, update);
          }
        },
        { iterations: 20 },
      );

      await tiered[Symbol.asyncDispose]();
      await store.dispose();
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.attributionMaps.clear();
    });
  });

  describe("cold read — loading from slow tier", () => {
    it("Tiered cold read vs direct unstorage read", async () => {
      const store = createStorage({ driver: fsDriver({ base: tmpDir }) });
      openStorages.push(store);

      const slow = new UnstorageDocumentStorage(store, { encrypted: false });
      const update = wrapUpdate(Y.encodeStateAsUpdateV2(createLargeDoc(5_000)));

      // Pre-populate slow tier with multiple docs
      for (let i = 0; i < 50; i++) {
        await slow.handleUpdate(`cold-doc-${i}`, update);
      }

      // Benchmark: direct unstorage read
      let idx = 0;
      await bench(
        "Unstorage direct getDocument",
        () => slow.getDocument(`cold-doc-${idx++ % 50}`),
        { iterations: 200 },
      );

      // Benchmark: tiered cold read (first access loads from slow)
      idx = 0;
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      const tiered = new TieredDocumentStorage(
        new MemoryDocumentStorage(false),
        slow,
        { persistIntervalMs: 60_000 },
      );

      await bench(
        "Tiered cold getDocument (1st access)",
        () => tiered.getDocument(`cold-doc-${idx++ % 50}`),
        { iterations: 200 },
      );

      // Benchmark: tiered warm read (already loaded)
      idx = 0;
      await bench(
        "Tiered warm getDocument (cached)",
        () => tiered.getDocument(`cold-doc-${idx++ % 50}`),
        { iterations: 200 },
      );

      await tiered[Symbol.asyncDispose]();
      await Promise.all(openStorages.splice(0).map((s) => s.dispose()));
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.attributionMaps.clear();
    });
  });
});
