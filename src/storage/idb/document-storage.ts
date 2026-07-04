import * as idb from "lib0/indexeddb";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { toBase64, fromBase64, toHexString } from "teleportal/utils";
import type { IndexedSidecar, SidecarIndex } from "../../lib/protocol/encryption/content-cipher";
import { EncryptedBinary } from "../../encryption-key";
import type { SidecarCompaction } from "../../lib/protocol/encryption/encoding";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
} from "../document-storage";
import type { DocumentMetadata } from "../types";

const STATE_STORE = "state";
const META_STORE = "meta";
const SIDECAR_STORE = "sidecars";
const PENDING_STORE = "pending";

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

function encodePendingUpdate(entry: PendingUpdate): string {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint8Array(encoder, entry.structureUpdate);

  encoding.writeVarUint(encoder, entry.sidecars.length);
  for (const s of entry.sidecars) {
    encoding.writeVarUint8Array(encoder, s.encrypted);
    encoding.writeVarUint(encoder, s.index.length);
    for (const r of s.index) {
      encoding.writeVarUint(encoder, r.clientId);
      encoding.writeVarUint(encoder, r.minClock);
      encoding.writeVarUint(encoder, r.maxClock);
    }
    encoding.writeVarUint8Array(encoder, s.hash);
  }

  encoding.writeUint8(encoder, entry.compaction ? 1 : 0);
  if (entry.compaction) {
    encoding.writeVarUint8Array(encoder, entry.compaction.sidecar);
    encoding.writeVarUint(encoder, entry.compaction.index.length);
    for (const r of entry.compaction.index) {
      encoding.writeVarUint(encoder, r.clientId);
      encoding.writeVarUint(encoder, r.minClock);
      encoding.writeVarUint(encoder, r.maxClock);
    }
    encoding.writeVarUint8Array(encoder, entry.compaction.hash);
    encoding.writeVarUint(encoder, entry.compaction.sourceHashes.length);
    for (const h of entry.compaction.sourceHashes) {
      encoding.writeVarUint8Array(encoder, h);
    }
  }

  return toBase64(encoding.toUint8Array(encoder));
}

function decodePendingUpdate(b64: string): PendingUpdate {
  const decoder = decoding.createDecoder(fromBase64(b64));
  const structureUpdate = decoding.readVarUint8Array(decoder);

  const sidecarCount = decoding.readVarUint(decoder);
  const sidecars: IndexedSidecar[] = [];
  for (let i = 0; i < sidecarCount; i++) {
    const encrypted = decoding.readVarUint8Array(decoder) as EncryptedBinary;
    const indexCount = decoding.readVarUint(decoder);
    const index: SidecarIndex = [];
    for (let j = 0; j < indexCount; j++) {
      index.push({
        clientId: decoding.readVarUint(decoder),
        minClock: decoding.readVarUint(decoder),
        maxClock: decoding.readVarUint(decoder),
      });
    }
    const hash = decoding.readVarUint8Array(decoder);
    sidecars.push({ encrypted, index, hash });
  }

  let compaction: SidecarCompaction | undefined;
  if (decoding.readUint8(decoder) === 1) {
    const sidecar = decoding.readVarUint8Array(decoder) as EncryptedBinary;
    const indexCount = decoding.readVarUint(decoder);
    const index: SidecarIndex = [];
    for (let j = 0; j < indexCount; j++) {
      index.push({
        clientId: decoding.readVarUint(decoder),
        minClock: decoding.readVarUint(decoder),
        maxClock: decoding.readVarUint(decoder),
      });
    }
    const hash = decoding.readVarUint8Array(decoder);
    const sourceCount = decoding.readVarUint(decoder);
    const sourceHashes: Uint8Array[] = [];
    for (let j = 0; j < sourceCount; j++) {
      sourceHashes.push(decoding.readVarUint8Array(decoder));
    }
    compaction = { sidecar, index, hash, sourceHashes };
  }

  return { structureUpdate, sidecars, compaction };
}

/**
 * IndexedDB-backed document storage.
 *
 * One IndexedDB database per document. Four object stores:
 * - `state`    — the compacted structure update + ordered sidecar-hash list
 * - `meta`     — document metadata (JSON string)
 * - `sidecars` — encrypted content blobs, keyed by content hash
 * - `pending`  — unmerged update log entries, keyed by auto-increment index
 */
export class IdbDocumentStorage extends AbstractDocumentStorage {
  #db: IDBDatabase | null = null;
  #dbPromise: Promise<IDBDatabase> | null = null;
  readonly #dbName: string;

  #activeStores: IDBObjectStore[] | null = null;

  #queue: Promise<unknown> = Promise.resolve();

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn, fn);
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
      idb.createStores(db, [[STATE_STORE], [META_STORE], [SIDECAR_STORE], [PENDING_STORE]]);
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
      const stores = idb.transact(
        db,
        [STATE_STORE, META_STORE, SIDECAR_STORE, PENDING_STORE],
        "readwrite",
      );
      this.#activeStores = stores;
      try {
        return await cb();
      } finally {
        this.#activeStores = null;
      }
    });
  }

  override getDocument(key: string) {
    return this.#run(() => super.getDocument(key));
  }

  // ── Pending log ────────────────────────────────────────────────────────

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    if (!this.#activeStores) await this.#open();
    const store = this.#getStore(PENDING_STORE, "readwrite");
    const raw = (await idb.get(store, key)) as unknown as string | undefined;
    const list: string[] = raw ? JSON.parse(raw) : [];
    list.push(encodePendingUpdate(entry));
    await idb.put(store, JSON.stringify(list), key);
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    if (!this.#activeStores) await this.#open();
    const store = this.#getStore(PENDING_STORE);
    const raw = (await idb.get(store, key)) as unknown as string | undefined;
    const list: string[] = raw ? JSON.parse(raw) : [];
    return {
      updates: list.map(decodePendingUpdate),
      cursor: list.length,
    };
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    if (!this.#activeStores) await this.#open();
    const store = this.#getStore(PENDING_STORE, "readwrite");
    const raw = (await idb.get(store, key)) as unknown as string | undefined;
    const list: string[] = raw ? JSON.parse(raw) : [];
    if (upToCursor >= list.length) {
      await idb.del(store, key);
    } else {
      await idb.put(store, JSON.stringify(list.slice(upToCursor)), key);
    }
  }

  // ── Base state ─────────────────────────────────────────────────────────

  async getBaseState(key: string): Promise<DocumentState | null> {
    if (!this.#activeStores) await this.#open();
    const stateStore = this.#getStore(STATE_STORE);
    const raw = (await idb.get(stateStore, key)) as unknown as string | undefined;
    if (!raw) return null;

    const { update, sidecarHashes } = decodeStateRow(raw);
    const sidecarStore = this.#getStore(SIDECAR_STORE);
    const sidecars: IndexedSidecar[] = [];
    for (const hash of sidecarHashes) {
      const row = (await idb.get(sidecarStore, toHexString(hash))) as unknown as string | undefined;
      if (!row) continue;
      const { encrypted, index } = decodeSidecarRow(row);
      sidecars.push({ encrypted, index, hash });
    }
    return { update, sidecars };
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    if (!this.#activeStores) await this.#open();
    const stateStore = this.#getStore(STATE_STORE, "readwrite");

    const prevRaw = (await idb.get(stateStore, key)) as unknown as string | undefined;
    const prevHexes = prevRaw
      ? decodeStateRow(prevRaw).sidecarHashes.map((h) => toHexString(h))
      : [];

    const newHashes = sidecars.map((s) => s.hash);
    const newHexes = newHashes.map((h) => toHexString(h));
    const newHexSet = new Set(newHexes);
    const prevHexSet = new Set(prevHexes);

    await idb.put(stateStore, encodeStateRow(update, newHashes), key);

    const sidecarStore = this.#getStore(SIDECAR_STORE, "readwrite");

    for (let i = 0; i < sidecars.length; i++) {
      if (prevHexSet.has(newHexes[i])) continue;
      const s = sidecars[i];
      await idb.put(sidecarStore, encodeSidecarRow(s.encrypted, s.index), newHexes[i]);
    }

    for (const hex of prevHexes) {
      if (!newHexSet.has(hex)) {
        await idb.del(sidecarStore, hex);
      }
    }
  }

  // ── Metadata ───────────────────────────────────────────────────────────

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

  // ── Delete ─────────────────────────────────────────────────────────────

  deleteDocument(key: string): Promise<void> {
    return this.transaction(key, async () => {
      const stateStore = this.#getStore(STATE_STORE, "readwrite");
      const metaStore = this.#getStore(META_STORE, "readwrite");
      const sidecarStore = this.#getStore(SIDECAR_STORE, "readwrite");
      const pendingStore = this.#getStore(PENDING_STORE, "readwrite");
      await Promise.all([
        idb.del(stateStore, key),
        idb.del(metaStore, key),
        idb.rtop(sidecarStore.clear()),
        idb.del(pendingStore, key),
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
