import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as Y from "yjs";
import { toHexString } from "lib0/buffer";
import {
  createEncryptionKey,
  decryptUpdate,
  type EncryptedBinary,
} from "teleportal/encryption-key";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  encryptUpdateContent,
  decodeSidecar,
  restoreContent,
  mergeSidecars,
  compactSidecars,
  hashSidecar,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import type { VersionedUpdate } from "teleportal";

// ───────────────────────────────────────────────────────────────────────────
// In-memory mock of `lib0/indexeddb`.
//
// Rather than pull in a heavyweight fake-indexeddb dependency, we replace the
// thin `lib0/indexeddb` wrapper our storage uses with a Map-backed shim. This
// drives the *real* IdbDocumentStorage code (encode/decode, row splitting,
// content-addressed sidecar add/delete, the op queue, getDocument
// reconstruction) and lets tests inspect exactly which rows exist. The
// `databases` map is module-scoped so tests can assert on stored rows and
// simulate a "page reload" by constructing a fresh storage over the same name.
// ───────────────────────────────────────────────────────────────────────────

type Store = Map<string, unknown>;
const databases = new Map<string, Map<string, Store>>();

class FakeStore {
  constructor(
    public name: string,
    public data: Store,
  ) {}
  clear() {
    this.data.clear();
    return { cleared: true };
  }
}

mock.module("lib0/indexeddb", () => ({
  openDB: async (name: string, initDB: (db: any) => void) => {
    let stores = databases.get(name);
    if (!stores) {
      stores = new Map<string, Store>();
      databases.set(name, stores);
      initDB({
        createObjectStore: (storeName: string) => {
          stores!.set(storeName, new Map());
        },
        objectStoreNames: { contains: (n: string) => stores!.has(n) },
        close: () => {},
      });
    }
    return { __name: name, close: () => {} };
  },
  createStores: (db: any, defs: Array<Array<string>>) => {
    for (const def of defs) db.createObjectStore(def[0]);
  },
  transact: (db: any, names: string[]) => {
    const stores = databases.get(db.__name)!;
    return names.map((n) => new FakeStore(n, stores.get(n)!));
  },
  get: async (store: FakeStore, key: string) => store.data.get(key),
  put: async (store: FakeStore, item: unknown, key: string) => {
    store.data.set(key, item);
  },
  del: async (store: FakeStore, key: string) => {
    store.data.delete(key);
  },
  rtop: async (req: unknown) => req,
}));

// Import AFTER the mock is registered so the storage binds to the shim.
const { IdbDocumentStorage } = await import("./document-storage");
type Storage = InstanceType<typeof IdbDocumentStorage>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function storeSizes(dbName: string) {
  const stores = databases.get(dbName);
  return {
    state: stores?.get("state")?.size ?? 0,
    meta: stores?.get("meta")?.size ?? 0,
    sidecars: stores?.get("sidecars")?.size ?? 0,
  };
}

function sidecarKeys(dbName: string): string[] {
  return Array.from(databases.get(dbName)?.get("sidecars")?.keys() ?? []);
}

function envelope(payload: Uint8Array): VersionedUpdate {
  return { version: 2, data: payload as EncryptedUpdatePayload } as unknown as VersionedUpdate;
}

/** Apply an edit to `ydoc`, encrypt the resulting diff, and persist it. Returns the sidecar. */
async function persistEdit(
  storage: Storage,
  docId: string,
  ydoc: Y.Doc,
  key: CryptoKey,
  edit: (doc: Y.Doc) => void,
): Promise<EncryptedBinary> {
  const before = Y.encodeStateVector(ydoc);
  edit(ydoc);
  const diff = Y.encodeStateAsUpdateV2(ydoc, before);
  const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, diff, 2);
  const payload = encodeContentEncryptedPayload({
    structureUpdate,
    encryptedSidecars: [encryptedSidecar],
  });
  await storage.handleUpdate(docId, envelope(payload));
  return encryptedSidecar;
}

/** Read the persisted document back, decrypt it, and return the reconstructed text. */
async function reconstruct(
  storage: Storage,
  docId: string,
  key: CryptoKey,
  field = "body",
): Promise<string | null> {
  const doc = await storage.getDocument(docId);
  if (!doc?.content.update) return null;
  const decoded = decodeContentEncryptedPayload(
    doc.content.update as unknown as EncryptedUpdatePayload,
  );
  const sidecars = [];
  for (const enc of decoded.encryptedSidecars) {
    sidecars.push(decodeSidecar(await decryptUpdate(key, enc)));
  }
  const restored = restoreContent(decoded.structureUpdate, mergeSidecars(sidecars));
  const probe = new Y.Doc();
  Y.applyUpdateV2(probe, restored);
  return probe.getText(field).toString();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("IdbDocumentStorage (mocked lib0/indexeddb)", () => {
  let key: CryptoKey;

  beforeEach(async () => {
    databases.clear();
    key = await createEncryptionKey();
  });

  it("creates the four object stores and round-trips an encrypted edit", async () => {
    const dbName = "teleportal-doc-rt";
    const storage = new IdbDocumentStorage(dbName, true);
    const ydoc = new Y.Doc();

    await persistEdit(storage, "doc", ydoc, key, (d) => d.getText("body").insert(0, "hello world"));

    expect(Array.from(databases.get(dbName)!.keys()).sort()).toEqual([
      "meta",
      "pending",
      "sidecars",
      "state",
    ]);
    expect(await reconstruct(storage, "doc", key)).toBe("hello world");

    // Compact to move data from pending to base state stores
    const state = await storage.getDocumentState("doc");
    await storage.replaceDocumentState("doc", state!.update, state!.sidecars);
    expect(storeSizes(dbName)).toEqual({ state: 1, meta: 1, sidecars: 1 });
  });

  it("keeps the state row small and stores each sidecar in its own content-addressed row", async () => {
    const dbName = "teleportal-doc-rows";
    const storage = new IdbDocumentStorage(dbName, true);
    const ydoc = new Y.Doc();

    const encA = await persistEdit(storage, "doc", ydoc, key, (d) =>
      d.getText("body").insert(0, "AAA"),
    );
    const encB = await persistEdit(storage, "doc", ydoc, key, (d) =>
      d.getText("body").insert(3, "BBB"),
    );

    expect(await reconstruct(storage, "doc", key)).toBe("AAABBB");

    // Compact to move sidecars from pending into the sidecar store
    const state = await storage.getDocumentState("doc");
    await storage.replaceDocumentState("doc", state!.update, state!.sidecars);

    // Two distinct sidecars, each keyed by its content hash.
    expect(storeSizes(dbName).sidecars).toBe(2);
    expect(sidecarKeys(dbName).sort()).toEqual(
      [toHexString(hashSidecar(encA)), toHexString(hashSidecar(encB))].sort(),
    );

    // The state row stays tiny (references both sidecars, doesn't inline them).
    const stateRow = databases.get(dbName)!.get("state")!.get("doc") as string;
    expect(stateRow.length).toBeLessThan(200);
  });

  it("compaction wipes superseded sidecar rows and still reconstructs", async () => {
    const dbName = "teleportal-doc-compact";
    const storage = new IdbDocumentStorage(dbName, true);
    const ydoc = new Y.Doc();

    const encA = await persistEdit(storage, "doc", ydoc, key, (d) =>
      d.getText("body").insert(0, "hello"),
    );
    const encB = await persistEdit(storage, "doc", ydoc, key, (d) =>
      d.getText("body").insert(5, " world"),
    );

    // Build a compaction that collapses sidecars A and B, riding on a real edit.
    const compacted = (await compactSidecars(key, [encA, encB]))!;
    expect(compacted).not.toBeNull();

    const before = Y.encodeStateVector(ydoc);
    ydoc.getText("body").insert(11, "!");
    const diff = Y.encodeStateAsUpdateV2(ydoc, before);
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, diff, 2);
    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
      compaction: {
        sidecar: compacted.encrypted,
        index: compacted.index,
        hash: compacted.hash,
        sourceHashes: [hashSidecar(encA), hashSidecar(encB)],
      },
    });
    await storage.handleUpdate("doc", envelope(payload));

    expect(await reconstruct(storage, "doc", key)).toBe("hello world!");

    // Compact to materialize and apply sidecar compaction to base state
    const state = await storage.getDocumentState("doc");
    await storage.replaceDocumentState("doc", state!.update, state!.sidecars);

    // A and B rows are gone; the compacted row + the new edit's row remain.
    expect(sidecarKeys(dbName)).not.toContain(toHexString(hashSidecar(encA)));
    expect(sidecarKeys(dbName)).not.toContain(toHexString(hashSidecar(encB)));
    expect(sidecarKeys(dbName)).toContain(toHexString(compacted.hash));
    expect(storeSizes(dbName).sidecars).toBe(2);
  });

  it("converges: many edits then a full compaction collapses the sidecar rows", async () => {
    const dbName = "teleportal-doc-converge";
    const storage = new IdbDocumentStorage(dbName, true);
    const ydoc = new Y.Doc();

    const N = 12;
    const encrypteds: EncryptedBinary[] = [];
    for (let i = 0; i < N; i++) {
      const ch = String.fromCharCode(97 + i);
      encrypteds.push(
        await persistEdit(storage, "doc", ydoc, key, (d) =>
          d.getText("body").insert(d.getText("body").length, ch),
        ),
      );
    }
    expect(await reconstruct(storage, "doc", key)).toBe("abcdefghijkl");

    // Compact ALL accumulated sidecars into one, riding a final edit.
    const compacted = (await compactSidecars(key, encrypteds))!;
    const before = Y.encodeStateVector(ydoc);
    ydoc.getText("body").insert(ydoc.getText("body").length, "!");
    const diff = Y.encodeStateAsUpdateV2(ydoc, before);
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, diff, 2);
    await storage.handleUpdate(
      "doc",
      envelope(
        encodeContentEncryptedPayload({
          structureUpdate,
          encryptedSidecars: [encryptedSidecar],
          compaction: {
            sidecar: compacted.encrypted,
            index: compacted.index,
            hash: compacted.hash,
            sourceHashes: encrypteds.map(hashSidecar),
          },
        }),
      ),
    );

    expect(await reconstruct(storage, "doc", key)).toBe("abcdefghijkl!");

    // Compact to materialize into base state stores
    const state = await storage.getDocumentState("doc");
    await storage.replaceDocumentState("doc", state!.update, state!.sidecars);

    // N sidecar rows collapse to 2 (the compacted blob + the final edit).
    expect(storeSizes(dbName).sidecars).toBe(2);
  });

  it("idempotent: replaying the same update does not grow the stored rows", async () => {
    const dbName = "teleportal-doc-idem";
    const storage = new IdbDocumentStorage(dbName, true);
    const ydoc = new Y.Doc();
    ydoc.getText("body").insert(0, "stable");
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(
      key,
      Y.encodeStateAsUpdateV2(ydoc),
      2,
    );
    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
    });

    await storage.handleUpdate("doc", envelope(payload));
    const sizesBefore = storeSizes(dbName);
    await storage.handleUpdate("doc", envelope(payload)); // replay
    expect(storeSizes(dbName)).toEqual(sizesBefore);
    expect(await reconstruct(storage, "doc", key)).toBe("stable");
  });

  it("at-rest secrecy: the plaintext marker is in no stored row", async () => {
    const dbName = "teleportal-doc-secret";
    const storage = new IdbDocumentStorage(dbName, true);
    const ydoc = new Y.Doc();
    const MARKER = "TOP_SECRET_MARKER_98765";

    await persistEdit(storage, "doc", ydoc, key, (d) => d.getText("body").insert(0, MARKER));

    const stores = databases.get(dbName)!;
    for (const [storeName, store] of stores) {
      if (storeName === "meta") continue; // metadata is plaintext JSON (sizes/timestamps)
      for (const value of store.values()) {
        expect(typeof value).toBe("string");
        expect(value as string).not.toContain(MARKER);
      }
    }
    // Sanity: it really does reconstruct to the marker.
    expect(await reconstruct(storage, "doc", key)).toBe(MARKER);
  });

  it("persists across a simulated reload (fresh storage, same DB name)", async () => {
    const dbName = "teleportal-doc-reload";
    const ydoc = new Y.Doc();

    const storage1 = new IdbDocumentStorage(dbName, true);
    await persistEdit(storage1, "doc", ydoc, key, (d) => d.getText("body").insert(0, "durable"));
    storage1.close();

    // A brand-new storage object over the same database — as a page reload would do.
    const storage2 = new IdbDocumentStorage(dbName, true);
    expect(await reconstruct(storage2, "doc", key)).toBe("durable");
  });

  it("deleteDocument clears every store for the document", async () => {
    const dbName = "teleportal-doc-delete";
    const storage = new IdbDocumentStorage(dbName, true);
    const ydoc = new Y.Doc();
    await persistEdit(storage, "doc", ydoc, key, (d) => d.getText("body").insert(0, "bye"));

    await storage.deleteDocument("doc");
    expect(storeSizes(dbName)).toEqual({ state: 0, meta: 0, sidecars: 0 });
    // Pending store should also be empty
    expect(databases.get(dbName)!.get("pending")!.size).toBe(0);
    expect(await storage.getDocument("doc")).toBeNull();
  });
});
