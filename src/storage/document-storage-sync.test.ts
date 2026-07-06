/**
 * End-to-end sync tests for the unified AbstractDocumentStorage, exercising the
 * ENCRYPTED path with REAL AES-GCM content encryption against BOTH backends
 * (in-memory and unstorage).
 *
 * Unlike the per-backend tests (which use "fake" encryption where the raw
 * sidecar bytes are cast directly to EncryptedBinary), these tests use a real
 * CryptoKey and `encryptUpdateContent` / `decryptContentPayload` from the
 * content-cipher. This proves the full round trip: a fresh client can take the
 * content-encrypted payload returned by handleSyncStep1, decrypt it with the
 * same key, and reconstruct the exact document state.
 */

import { beforeEach, afterEach, afterAll, describe, expect, it } from "bun:test";
import { createStorage, type Storage } from "unstorage";
import * as Y from "yjs";

import type { StateVector, Update, VersionedUpdate } from "teleportal";
import { getEmptyStateVector } from "teleportal";
import {
  type EncryptedBinary,
  createEncryptionKey,
  decryptUpdate,
  encryptUpdate,
} from "teleportal/encryption-key";
import {
  buildSidecarIndex,
  decodeContentEncryptedPayload,
  decodeSidecar,
  decryptContentPayload,
  encodeContentEncryptedPayload,
  encodeSidecar,
  encryptUpdateContent,
  hashSidecar,
  mergeSidecars,
  type EncryptedUpdatePayload,
  type IndexedSidecar,
  type SidecarCompaction,
} from "teleportal/protocol/encryption";

import { DurableObjectDocumentStorage } from "../cloudflare/document-storage";
import { FakeDOStorage } from "../cloudflare/fake-do-storage";
import type { AbstractDocumentStorage } from "./document-storage";
import { MemoryDocumentStorage } from "./in-memory/document-storage";
import { MergeOnWriteStorage } from "./merge-on-write-storage";
import { PostgresDocumentStorage } from "./postgres/document-storage";
import { dropSchema, ensureSchema } from "./postgres/schema";
import { isPostgresAvailable, makeTestSql, randomTablePrefix } from "./postgres/test-utils";
import { TieredDocumentStorage } from "./tiered/document-storage";
import { UnstorageDocumentStorage } from "./unstorage/document-storage";

// ── Backend harness ───────────────────────────────────────────────────────────

type Backend = {
  name: string;
  /** Construct a fresh ENCRYPTED storage instance. */
  make: () => AbstractDocumentStorage;
  /** Tear down any external resources (e.g. unstorage instances). */
  cleanup: () => Promise<void>;
};

const openStorages: Storage[] = [];

const backends: Backend[] = [
  {
    name: "MemoryDocumentStorage",
    make: () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.pendingUpdates.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      return new MemoryDocumentStorage(true);
    },
    cleanup: async () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.pendingUpdates.clear();
      MemoryDocumentStorage.attributionMaps.clear();
    },
  },
  {
    name: "UnstorageDocumentStorage",
    make: () => {
      const store = createStorage();
      openStorages.push(store);
      return new UnstorageDocumentStorage(store, { encrypted: true });
    },
    cleanup: async () => {
      await Promise.all(openStorages.splice(0).map((s) => s.dispose()));
    },
  },
  {
    name: "TieredDocumentStorage",
    make: () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.pendingUpdates.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      const store = createStorage();
      openStorages.push(store);
      return new TieredDocumentStorage(
        new MemoryDocumentStorage(true),
        new UnstorageDocumentStorage(store, { encrypted: true }),
        { persistIntervalMs: 60_000 },
      );
    },
    cleanup: async () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.pendingUpdates.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      await Promise.all(openStorages.splice(0).map((s) => s.dispose()));
    },
  },
  {
    name: "DurableObjectDocumentStorage",
    make: () => new DurableObjectDocumentStorage(new FakeDOStorage(), { encrypted: true }),
    cleanup: async () => {},
  },
  {
    name: "MergeOnWriteStorage",
    make: () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.pendingUpdates.clear();
      MemoryDocumentStorage.attributionMaps.clear();
      return new MergeOnWriteStorage(new MemoryDocumentStorage(true));
    },
    cleanup: async () => {
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.pendingUpdates.clear();
      MemoryDocumentStorage.attributionMaps.clear();
    },
  },
];

// Postgres backend — registered only when a server is reachable, following
// the Redis transport tests' availability-check convention.
const pgPrefix = randomTablePrefix();
const pgAvailable = await isPostgresAvailable();
let pgSql: ReturnType<typeof makeTestSql> | undefined;
const pgStorages: PostgresDocumentStorage[] = [];
if (pgAvailable) {
  pgSql = makeTestSql(4);
  await ensureSchema(pgSql, { tablePrefix: pgPrefix });
  backends.push({
    name: "PostgresDocumentStorage",
    make: () => {
      const storage = new PostgresDocumentStorage(pgSql!, {
        tablePrefix: pgPrefix,
        encrypted: true,
      });
      pgStorages.push(storage);
      return storage;
    },
    cleanup: async () => {
      // Release each instance's dedicated lock connection back to the pool
      // before truncating, so instances never accumulate reservations.
      await Promise.all(pgStorages.splice(0).map((s) => s.close()));
      await pgSql!.unsafe(
        `TRUNCATE ${pgPrefix}documents, ${pgPrefix}pending_updates, ${pgPrefix}attributions`,
      );
    },
  });
} else {
  console.log("Skipping Postgres compliance backend - Postgres not available");
}

afterAll(async () => {
  await Promise.all(pgStorages.splice(0).map((s) => s.close()));
  if (pgSql) {
    await dropSchema(pgSql, { tablePrefix: pgPrefix });
    await pgSql.end();
  }
});

// ── Encryption helpers (REAL AES-GCM) ─────────────────────────────────────────

/**
 * Encrypt a Y.js V2 update into the content-encrypted envelope that
 * handleUpdate expects, using a real CryptoKey.
 */
async function makeEncryptedUpdate(key: CryptoKey, v2Update: Uint8Array): Promise<VersionedUpdate> {
  const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, v2Update, 2);
  const payload = encodeContentEncryptedPayload({
    structureUpdate,
    encryptedSidecars: [encryptedSidecar],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

/**
 * Decrypt a content-encrypted payload (structure update + encrypted sidecars)
 * returned from storage back into a plaintext V2 Y.js update.
 */
async function decryptPayload(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  const decoded = decodeContentEncryptedPayload(payload as EncryptedUpdatePayload);
  return decryptContentPayload(
    key,
    decoded.structureUpdate,
    decoded.encryptedSidecars as EncryptedBinary[],
    2,
  );
}

/** Build a fresh Y.Doc from a decrypted V2 update. */
function applyV2(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  if (update.length > 0) Y.applyUpdateV2(doc, update);
  return doc;
}

/** A simple structural snapshot of a doc's `root` map for equality assertions. */
function snapshotRoot(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap("root").toJSON();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.each(backends)("AbstractDocumentStorage encrypted sync ($name)", (backend) => {
  let storage: AbstractDocumentStorage;
  let key: CryptoKey;

  beforeEach(async () => {
    storage = backend.make();
    key = await createEncryptionKey();
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  // ── 1. Full sync round trip ────────────────────────────────────────────────

  it("full sync round trip: fresh client reconstructs exact encrypted doc state", async () => {
    const docKey = "doc-roundtrip";

    // Client A writes two separate updates via handleUpdate.
    const docA = new Y.Doc();
    docA.clientID = 111;
    docA.getMap("root").set("title", "Hello");
    docA.getText("body").insert(0, "The quick brown fox");
    await storage.handleUpdate(
      docKey,
      await makeEncryptedUpdate(key, Y.encodeStateAsUpdateV2(docA)),
    );

    // A second, dependent update from the same client.
    docA.getMap("root").set("count", 42);
    docA.getText("body").insert(19, " jumps over the lazy dog");
    const diff2 = Y.encodeStateAsUpdateV2(docA, Y.encodeStateVector(new Y.Doc()));
    await storage.handleUpdate(docKey, await makeEncryptedUpdate(key, diff2));

    // A fresh client with no state syncs.
    const clientSV = getEmptyStateVector();
    const result = await storage.handleSyncStep1(docKey, clientSV);

    // Decrypt the returned content-encrypted payload. This is the critical
    // sidecar-filtering correctness check: it must NOT reject with a
    // "missing sidecar entry" error.
    const restored = await decryptPayload(key, result.content.update).catch((err) => {
      throw new Error(`decryptPayload rejected (sidecar filtering bug?): ${err}`);
    });

    const reconstructed = applyV2(restored);

    // Exact state match against the authoritative client A doc.
    expect(snapshotRoot(reconstructed)).toEqual(snapshotRoot(docA));
    expect(reconstructed.getText("body").toString()).toBe(docA.getText("body").toString());
    expect(reconstructed.getText("body").toString()).toBe(
      "The quick brown fox jumps over the lazy dog",
    );

    // The returned state vector must reflect the full server state.
    const serverSV = result.content.stateVector;
    expect(new Uint8Array(serverSV)).toEqual(new Uint8Array(Y.encodeStateVector(docA)));
  });

  // ── 2. Partial sync ────────────────────────────────────────────────────────

  it("partial sync: returns only the diff + overlapping sidecars, client reconstructs", async () => {
    const docKey = "doc-partial";

    // Client A writes the first update.
    const docA = new Y.Doc();
    docA.clientID = 100;
    docA.getMap("root").set("a", 1);
    const updateA = Y.encodeStateAsUpdateV2(docA);
    await storage.handleUpdate(docKey, await makeEncryptedUpdate(key, updateA));

    // The "partial" client already has client A's state.
    const partialSV = Y.encodeStateVector(docA) as StateVector;

    // Client B writes an independent update.
    const docB = new Y.Doc();
    docB.clientID = 200;
    docB.getMap("root").set("b", 2);
    const updateB = Y.encodeStateAsUpdateV2(docB);
    await storage.handleUpdate(docKey, await makeEncryptedUpdate(key, updateB));

    // Sanity: server accumulated two sidecars.
    const state = await storage.getDocumentState(docKey);
    expect(state!.sidecars.length).toBe(2);

    // Partial client syncs.
    const result = await storage.handleSyncStep1(docKey, partialSV);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // Only the overlapping sidecar (B's) is returned, not both.
    expect(decoded.encryptedSidecars.length).toBe(1);

    // Decrypt + apply the diff onto a client that already has A's state.
    const restoredDiff = await decryptPayload(key, result.content.update);
    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, updateA);
    Y.applyUpdateV2(clientDoc, restoredDiff);

    expect(clientDoc.getMap("root").get("a")).toBe(1);
    expect(clientDoc.getMap("root").get("b")).toBe(2);

    // And the full server state decrypts correctly for a brand-new client too.
    const full = await storage.getDocument(docKey);
    const fullRestored = await decryptPayload(key, full!.content.update);
    const fullDoc = applyV2(fullRestored);
    expect(fullDoc.getMap("root").get("a")).toBe(1);
    expect(fullDoc.getMap("root").get("b")).toBe(2);
  });

  // ── 3. Multiple sidecars + compaction (handleCompaction) ───────────────────

  it("accumulates multiple sidecars; compaction replaces them and stays decryptable", async () => {
    const docKey = "doc-compact";

    // Three independent updates → three sidecars.
    const clientIds = [100, 200, 300];
    const expected: Record<string, number> = {};
    for (let i = 0; i < clientIds.length; i++) {
      const doc = new Y.Doc();
      doc.clientID = clientIds[i];
      doc.getMap("root").set(`key-${i}`, i + 1);
      expected[`key-${i}`] = i + 1;
      await storage.handleUpdate(
        docKey,
        await makeEncryptedUpdate(key, Y.encodeStateAsUpdateV2(doc)),
      );
    }

    let state = await storage.getDocumentState(docKey);
    expect(state!.sidecars.length).toBe(3);

    // getDocumentState reflects the merged structure (all three clients).
    const svBefore = Y.encodeStateVectorFromUpdateV2(state!.update);
    expect(Y.decodeStateVector(svBefore).size).toBe(3);

    // Build a real compacted sidecar: decrypt all three, merge, re-encrypt.
    const decryptedSidecars = await Promise.all(
      state!.sidecars.map(async (s) => decodeSidecar(await decryptSidecarBytes(key, s.encrypted))),
    );
    const mergedSidecar = mergeSidecars(decryptedSidecars);
    const compactedEncrypted = await encryptUpdate(key, encodeSidecar(mergedSidecar));
    const compactedSidecar: IndexedSidecar = {
      encrypted: compactedEncrypted,
      index: buildSidecarIndex(mergedSidecar.entries),
      hash: await hashSidecar(compactedEncrypted),
    };

    const baseSV = Y.encodeStateVectorFromUpdateV2(state!.update);
    const accepted = await storage.handleCompaction(docKey, compactedSidecar, baseSV);
    expect(accepted).toBe(true);

    // Matched sidecars replaced by exactly one.
    state = await storage.getDocumentState(docKey);
    expect(state!.sidecars.length).toBe(1);

    // The doc still decrypts to the same state.
    const doc = await storage.getDocument(docKey);
    const restored = await decryptPayload(key, doc!.content.update);
    const reconstructed = applyV2(restored);
    expect(snapshotRoot(reconstructed)).toEqual(expected);

    // Advance the document state with a concurrent write so the previously
    // captured baseSV becomes stale.
    const docD = new Y.Doc();
    docD.clientID = 400;
    docD.getMap("root").set("key-3", 4);
    await storage.handleUpdate(
      docKey,
      await makeEncryptedUpdate(key, Y.encodeStateAsUpdateV2(docD)),
    );
    expect((await storage.getDocumentState(docKey))!.sidecars.length).toBe(2);

    // Stale baseSV → handleCompaction returns false (optimistic concurrency)
    // and leaves the state untouched.
    const rejected = await storage.handleCompaction(docKey, compactedSidecar, baseSV);
    expect(rejected).toBe(false);
    expect((await storage.getDocumentState(docKey))!.sidecars.length).toBe(2);
  });

  // ── 3b. Inline compaction piggy-backed on handleUpdate ─────────────────────

  it("inline compaction via handleUpdate replaces matched sidecars and decrypts intact", async () => {
    const docKey = "doc-inline-compact";

    for (let i = 1; i <= 3; i++) {
      const doc = new Y.Doc();
      doc.clientID = i * 100;
      doc.getMap("root").set(`key-${i}`, i);
      await storage.handleUpdate(
        docKey,
        await makeEncryptedUpdate(key, Y.encodeStateAsUpdateV2(doc)),
      );
    }

    let state = await storage.getDocumentState(docKey);
    expect(state!.sidecars.length).toBe(3);

    const compaction = await buildCompaction(key, state!.sidecars);

    // New client connects: same state as server, produces a no-op diff but
    // carries the compaction. Reconstruct full server doc to compute the diff.
    const full = await storage.getDocument(docKey);
    const serverSV = full!.content.stateVector;
    const serverDoc = applyV2(await decryptPayload(key, full!.content.update));
    const noOpDiff = Y.encodeStateAsUpdateV2(serverDoc, serverSV);

    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, noOpDiff, 2);
    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
      compaction,
    });
    await storage.handleUpdate(docKey, {
      version: 2,
      data: payload as Update,
    } as VersionedUpdate);

    // No-op diff added no sidecar; the 3 source sidecars collapse to 1 compacted.
    state = await storage.getDocumentState(docKey);
    expect(state!.sidecars.length).toBe(1);
    expect(state!.sidecars[0].hash).toEqual(compaction.hash);

    // Next client connecting decrypts the compacted state intact.
    const next = await storage.getDocument(docKey);
    const restored = await decryptPayload(key, next!.content.update);
    const reconstructed = applyV2(restored);
    expect(reconstructed.getMap("root").get("key-1")).toBe(1);
    expect(reconstructed.getMap("root").get("key-2")).toBe(2);
    expect(reconstructed.getMap("root").get("key-3")).toBe(3);
  });

  // ── 3c. Delete-only update persists and round-trips correctly ──────────────

  it("delete-only update is persisted and a fresh client sees the deletion", async () => {
    const docKey = "doc-delete";

    // Client inserts "Hello World".
    const doc = new Y.Doc();
    doc.clientID = 111;
    doc.getText("body").insert(0, "Hello World");
    const svAfterInsert = Y.encodeStateVector(doc);
    await storage.handleUpdate(
      docKey,
      await makeEncryptedUpdate(key, Y.encodeStateAsUpdateV2(doc)),
    );

    // Client deletes "World" — this update carries only a delete set, no
    // new struct items, so the state vector does NOT advance.
    doc.getText("body").delete(6, 5);
    expect(doc.getText("body").toString()).toBe("Hello ");
    const deleteOnlyDiff = Y.encodeStateAsUpdateV2(doc, svAfterInsert);
    await storage.handleUpdate(docKey, await makeEncryptedUpdate(key, deleteOnlyDiff));

    // The stored state should reflect the deletion: a fresh client syncing
    // from scratch must see "Hello ", not "Hello World".
    const result = await storage.handleSyncStep1(docKey, getEmptyStateVector());
    const restored = await decryptPayload(key, result.content.update);
    const reconstructed = applyV2(restored);
    expect(reconstructed.getText("body").toString()).toBe("Hello ");

    // No spurious sidecar growth — the delete-only update has no new
    // encrypted content, so only the original sidecar should remain.
    const state = await storage.getDocumentState(docKey);
    expect(state!.sidecars.length).toBe(1);
  });

  // ── 4. Re-applied update ───────────────────────────────────────────────────

  it("re-applied insert update is idempotent on state vector (sidecar compaction handles dup ciphertexts)", async () => {
    const docKey = "doc-noop";

    const doc = new Y.Doc();
    doc.clientID = 100;
    doc.getMap("root").set("k", "v");
    const v2 = Y.encodeStateAsUpdateV2(doc);
    const update = await makeEncryptedUpdate(key, v2);

    await storage.handleUpdate(docKey, update);
    const first = await storage.getDocumentState(docKey);
    const svFirst = Y.encodeStateVectorFromUpdateV2(first!.update);
    expect(first!.sidecars.length).toBe(1);

    // Re-apply the exact same update. The CRDT state is idempotent under the
    // merge, so the state vector does not change. Sidecars DO accumulate
    // (deterring duplicates cheaply on the hot path costs an O(doc) byte
    // compare, which doesn't scale to large docs — compaction is the
    // mechanism for cleaning these up).
    await storage.handleUpdate(docKey, update);
    const second = await storage.getDocumentState(docKey);
    const svSecond = Y.encodeStateVectorFromUpdateV2(second!.update);
    expect(new Uint8Array(svSecond)).toEqual(new Uint8Array(svFirst));

    // A re-encrypted (different ciphertext) but content-identical update is
    // also CRDT-idempotent.
    const reEncrypted = await makeEncryptedUpdate(key, v2);
    await storage.handleUpdate(docKey, reEncrypted);
    const third = await storage.getDocumentState(docKey);
    expect(new Uint8Array(Y.encodeStateVectorFromUpdateV2(third!.update))).toEqual(
      new Uint8Array(svFirst),
    );
  });
});

// ── Local helpers that need the real key ──────────────────────────────────────

function decryptSidecarBytes(key: CryptoKey, encrypted: EncryptedBinary): Promise<Uint8Array> {
  return decryptUpdate(key, encrypted);
}

async function buildCompaction(
  key: CryptoKey,
  sidecars: IndexedSidecar[],
): Promise<SidecarCompaction> {
  const decrypted = await Promise.all(
    sidecars.map(async (s) => decodeSidecar(await decryptSidecarBytes(key, s.encrypted))),
  );
  const merged = mergeSidecars(decrypted);
  const encrypted = await encryptUpdate(key, encodeSidecar(merged));
  return {
    sidecar: encrypted,
    index: buildSidecarIndex(merged.entries),
    hash: await hashSidecar(encrypted),
    sourceHashes: await Promise.all(sidecars.map((s) => hashSidecar(s.encrypted))),
  };
}
