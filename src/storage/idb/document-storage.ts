import * as idb from "lib0/indexeddb";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { toBase64, fromBase64, toHexString } from "lib0/buffer";
import type { IndexedSidecar, SidecarIndex } from "../../lib/protocol/encryption/content-cipher";
import { EncryptedBinary } from "../../encryption-key";
import { AbstractDocumentStorage, type DocumentState } from "../document-storage";
import type { DocumentMetadata } from "../types";

const STATE_STORE = "state";
const META_STORE = "meta";
const SIDECAR_STORE = "sidecars";

/**
 * Encodes the document's structure update plus the ordered list of sidecar
 * hashes that make up its current state. Sidecar *content* lives in its own
 * store (keyed by hash), so this row stays small and only references them.
 */
function encodeStateRow(update: Uint8Array, sidecarHashes: Uint8Array[]): string {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint8Array(encoder, update);
  encoding.writeVarUint(encoder, sidecarHashes.length);
  for (const hash of sidecarHashes) {
    encoding.writeVarUint8Array(encoder, hash);
  }
  return toBase64(encoding.toUint8Array(encoder));
}

function decodeStateRow(b64: string): { update: Uint8Array; sidecarHashes: Uint8Array[] } {
  const decoder = decoding.createDecoder(fromBase64(b64));
  const update = decoding.readVarUint8Array(decoder);
  const count = decoding.readVarUint(decoder);
  const sidecarHashes: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    sidecarHashes.push(decoding.readVarUint8Array(decoder));
  }
  return { update, sidecarHashes };
}

/** Encodes a single sidecar (encrypted content + its CRDT index) for its own row. */
function encodeSidecarRow(encrypted: Uint8Array, index: SidecarIndex): string {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint8Array(encoder, encrypted);
  encoding.writeVarUint(encoder, index.length);
  for (const entry of index) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.minClock);
    encoding.writeVarUint(encoder, entry.maxClock);
  }
  return toBase64(encoding.toUint8Array(encoder));
}

function decodeSidecarRow(b64: string): { encrypted: EncryptedBinary; index: SidecarIndex } {
  const decoder = decoding.createDecoder(fromBase64(b64));
  const encrypted = decoding.readVarUint8Array(decoder) as EncryptedBinary;
  const count = decoding.readVarUint(decoder);
  const index: SidecarIndex = [];
  for (let i = 0; i < count; i++) {
    index.push({
      clientId: decoding.readVarUint(decoder),
      minClock: decoding.readVarUint(decoder),
      maxClock: decoding.readVarUint(decoder),
    });
  }
  return { encrypted, index };
}

/**
 * IndexedDB-backed document storage.
 *
 * One IndexedDB database per document. Three object stores:
 * - `meta`     — document metadata (one row, keyed by document id; JSON string)
 * - `state`    — the merged structure update + ordered sidecar-hash list
 *                (one row, keyed by document id; base64)
 * - `sidecars` — encrypted content blobs, one row each, keyed by content hash.
 *
 * Sidecars are immutable and content-addressed, so a `replaceDocumentState`
 * only *adds* newly-seen sidecars and *deletes* the ones a compaction dropped —
 * the unchanged sidecar rows (the bulk of the data) are never rewritten.
 */
export class IdbDocumentStorage extends AbstractDocumentStorage {
  #db: IDBDatabase | null = null;
  #dbPromise: Promise<IDBDatabase> | null = null;
  readonly #dbName: string;

  // Active transaction stores — set by transaction() so primitives
  // called inside a transaction() callback reuse the same IDB transaction.
  #activeStores: IDBObjectStore[] | null = null;

  // Serializes all IDB operations. Persistence is fired concurrently from
  // multiple seams (outgoing edits, incoming server updates) without being
  // awaited, so without this two operations could interleave and clobber the
  // shared #activeStores / IDB transaction. The queue guarantees one operation
  // at a time, which also gives the atomic read-merge-write needed across tabs.
  #queue: Promise<unknown> = Promise.resolve();

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn, fn);
    // Keep the chain alive regardless of individual op success/failure.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  constructor(dbName: string, encrypted: boolean = true) {
    super(encrypted);
    this.#dbName = dbName;
  }

  async #open(): Promise<IDBDatabase> {
    if (this.#db) return this.#db;
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = idb.openDB(this.#dbName, (db: IDBDatabase) => {
      idb.createStores(db, [[STATE_STORE], [META_STORE], [SIDECAR_STORE]]);
    });
    this.#db = await this.#dbPromise;
    this.#dbPromise = null;
    return this.#db;
  }

  #getStore(name: string, mode: "readonly" | "readwrite" = "readonly"): IDBObjectStore {
    if (this.#activeStores) {
      const store = this.#activeStores.find((s) => s.name === name);
      if (store) return store;
    }
    const db = this.#db;
    if (!db) throw new Error("IdbDocumentStorage: database not open");
    const [store] = idb.transact(db, [name], mode);
    return store;
  }

  override transaction<T>(_key: string, cb: () => Promise<T>): Promise<T> {
    return this.#run(async () => {
      const db = await this.#open();
      const stores = idb.transact(db, [STATE_STORE, META_STORE, SIDECAR_STORE], "readwrite");
      this.#activeStores = stores;
      try {
        return await cb();
      } finally {
        this.#activeStores = null;
      }
    });
  }

  // Reads run outside a transaction() (e.g. getDocument during replay), so route
  // them through the same queue to avoid overlapping a write's #activeStores
  // window. Safe from re-entrancy: getDocument does not call transaction().
  override getDocument(key: string) {
    return this.#run(() => super.getDocument(key));
  }

  // Inside a transaction() call the DB is already open.  We MUST NOT
  // `await` anything before issuing the first IDB request — even
  // `await undefined` yields a microtask that lets the IDB transaction
  // auto-commit.  Guard every primitive with this pattern instead.

  async getDocumentState(key: string): Promise<DocumentState | null> {
    if (!this.#activeStores) await this.#open();
    const stateStore = this.#getStore(STATE_STORE);
    const raw = (await idb.get(stateStore, key)) as unknown as string | undefined;
    if (!raw) return null;

    const { update, sidecarHashes } = decodeStateRow(raw);
    const sidecarStore = this.#getStore(SIDECAR_STORE);
    const sidecars: IndexedSidecar[] = [];
    for (const hash of sidecarHashes) {
      const row = (await idb.get(sidecarStore, toHexString(hash))) as unknown as string | undefined;
      if (!row) continue; // referenced sidecar missing — skip defensively
      const { encrypted, index } = decodeSidecarRow(row);
      sidecars.push({ encrypted, index, hash });
    }
    return { update, sidecars };
  }

  async replaceDocumentState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    if (!this.#activeStores) await this.#open();
    const stateStore = this.#getStore(STATE_STORE, "readwrite");

    // Read the previously-referenced sidecar hashes so we can delete the ones
    // that this new state no longer references (e.g. dropped by a compaction).
    const prevRaw = (await idb.get(stateStore, key)) as unknown as string | undefined;
    const prevHexes = prevRaw
      ? decodeStateRow(prevRaw).sidecarHashes.map((h) => toHexString(h))
      : [];

    const newHashes = sidecars.map((s) => s.hash);
    const newHexes = newHashes.map((h) => toHexString(h));
    const newHexSet = new Set(newHexes);
    const prevHexSet = new Set(prevHexes);

    // Rewrite the (small) state row — structure update + ordered hash list.
    await idb.put(stateStore, encodeStateRow(update, newHashes), key);

    const sidecarStore = this.#getStore(SIDECAR_STORE, "readwrite");

    // Add only sidecars we haven't stored before (content-addressed & immutable).
    for (let i = 0; i < sidecars.length; i++) {
      if (prevHexSet.has(newHexes[i])) continue;
      const s = sidecars[i];
      await idb.put(sidecarStore, encodeSidecarRow(s.encrypted, s.index), newHexes[i]);
    }

    // Delete sidecars no longer referenced (compaction wipes the superseded rows).
    for (const hex of prevHexes) {
      if (!newHexSet.has(hex)) {
        await idb.del(sidecarStore, hex);
      }
    }
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    if (!this.#activeStores) await this.#open();
    const now = Date.now();
    const store = this.#getStore(META_STORE);
    const raw = (await idb.get(store, key)) as unknown as string | undefined;
    if (!raw) {
      return { createdAt: now, updatedAt: now, encrypted: this.encrypted };
    }
    const m = JSON.parse(raw) as DocumentMetadata;
    return {
      ...m,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now,
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now,
      encrypted: typeof m.encrypted === "boolean" ? m.encrypted : this.encrypted,
    };
  }

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    if (!this.#activeStores) await this.#open();
    const store = this.#getStore(META_STORE, "readwrite");
    await idb.put(store, JSON.stringify(metadata), key);
  }

  deleteDocument(key: string): Promise<void> {
    // Serialize + run as one atomic transaction (the base class never calls
    // deleteDocument from inside a transaction, so this can't re-enter).
    return this.transaction(key, async () => {
      const stateStore = this.#getStore(STATE_STORE, "readwrite");
      const metaStore = this.#getStore(META_STORE, "readwrite");
      // One DB per document, so the sidecars store only holds this document's
      // sidecars — clearing it wholesale is correct and cheaper than per-key dels.
      const sidecarStore = this.#getStore(SIDECAR_STORE, "readwrite");
      await Promise.all([
        idb.del(stateStore, key),
        idb.del(metaStore, key),
        idb.rtop(sidecarStore.clear()),
      ]);
    });
  }

  close(): void {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }
}
