import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { EncryptedBinary } from "teleportal/encryption-key";
import type {
  StateVector,
  Update,
  VersionedUpdate,
  VersionedSyncStep2Update,
  SyncStep2UpdateV2,
} from "teleportal";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  stripContent,
  encodeSidecar,
  decodeSidecar,
  restoreContent,
  mergeSidecars,
  hashSidecar,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { getEmptyStateVector } from "../../lib/protocol/utils";
import {
  createContentAttribute,
  createContentIds,
  createContentIdsFromUpdate,
  createContentMapFromContentIds,
  decodeContentMap,
  encodeContentMap,
  mergeContentMaps,
  IdSet,
} from "teleportal/attribution";
import { MemoryDocumentStorage } from "./document-storage";
import type { EncodedContentMap, FileStorage } from "../types";

// ── Shared helpers ──────────────────────────────────────────────────────────

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: bytes,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

/**
 * Create a content-encrypted update payload from a raw Y.js V1 update.
 * Uses fake encryption -- the raw sidecar bytes are cast directly as EncryptedBinary.
 */
function makeContentEncryptedUpdate(v2Update: Uint8Array): EncryptedUpdatePayload {
  const { update: structureUpdate, sidecar } = stripContent(v2Update, 2);
  const sidecarBytes = encodeSidecar(sidecar);
  return encodeContentEncryptedPayload({
    structureUpdate,
    encryptedSidecars: [sidecarBytes as EncryptedBinary],
  }) as EncryptedUpdatePayload;
}

/**
 * Wrap an already-encoded content-encrypted payload into a VersionedUpdate.
 * Use this for encrypted tests where makeContentEncryptedUpdate() already produces
 * the envelope payload and it should NOT be re-encoded by versionedUpdate().
 */
function envelopeUpdate(payload: Uint8Array): VersionedUpdate {
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

/** Decode a content-encrypted payload to get the structure update (V1). */
function getStructureUpdate(update: Uint8Array): Uint8Array {
  return decodeContentEncryptedPayload(update as EncryptedUpdatePayload).structureUpdate;
}

/** Apply a content-encrypted payload from storage to a fresh Y.Doc and return it. */
function docFromUpdate(update: Uint8Array): Y.Doc {
  const structureUpdate = getStructureUpdate(update);
  const doc = new Y.Doc();
  if (structureUpdate.length > 0) {
    Y.applyUpdateV2(doc, structureUpdate);
  }
  return doc;
}

// ── Unencrypted ─────────────────────────────────────────────────────────────

describe("MemoryDocumentStorage (unencrypted)", () => {
  let storage: MemoryDocumentStorage;
  let _mockFileStorage: FileStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    MemoryDocumentStorage.attributionCache.clear();
    storage = new MemoryDocumentStorage(false);
  });

  describe("handleUpdate", () => {
    it("should create a new document if it doesn't exist", async () => {
      const key = "test-doc-1";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Hello, World!");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));

      expect(MemoryDocumentStorage.docs.has(key)).toBe(true);
      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const storedDoc = docFromUpdate(retrieved!.content.update);
      expect(storedDoc.getText("content").toString()).toBe("Hello, World!");
    });

    it("should apply updates to existing document", async () => {
      const key = "test-doc-2";
      const doc1 = new Y.Doc();
      const text1 = doc1.getText("content");
      text1.insert(0, "Hello");
      const update1 = Y.encodeStateAsUpdateV2(doc1) as Update;

      await storage.handleUpdate(key, versionedUpdate(update1));

      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      const text2 = doc2.getText("content");
      text2.insert(5, ", World!");
      const update2 = Y.encodeStateAsUpdateV2(doc2) as Update;

      await storage.handleUpdate(key, versionedUpdate(update2));

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const storedDoc = docFromUpdate(retrieved!.content.update);
      expect(storedDoc.getText("content").toString()).toBe("Hello, World!");
    });

    it("should update metadata updatedAt timestamp", async () => {
      const key = "test-doc-3";
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      const beforeTime = Date.now();
      await storage.handleUpdate(key, versionedUpdate(update));
      const afterTime = Date.now();

      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(metadata.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it("multi-client updates merge correctly", async () => {
      const key = "test-doc-multi-client";

      // Client A creates an update
      const docA = new Y.Doc();
      docA.getText("content").insert(0, "Hello");
      const updateA = Y.encodeStateAsUpdateV2(docA) as Update;

      // Client B creates an independent update
      const docB = new Y.Doc();
      docB.getText("content").insert(0, "World");
      const updateB = Y.encodeStateAsUpdateV2(docB) as Update;

      // Both updates are stored
      await storage.handleUpdate(key, versionedUpdate(updateA));
      await storage.handleUpdate(key, versionedUpdate(updateB));

      // Verify the merged state includes both contributions
      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const mergedDoc = docFromUpdate(retrieved!.content.update);
      const text = mergedDoc.getText("content").toString();
      // Both clients' text should be present in the merged result
      expect(text).toContain("Hello");
      expect(text).toContain("World");
    });

    it("duplicate update is deduped", async () => {
      const key = "test-doc-dedup";
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "Hello");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      // First write
      await storage.handleUpdate(key, versionedUpdate(update));
      const stateAfterFirst = await storage.getDocument(key);
      expect(stateAfterFirst).not.toBeNull();
      const svAfterFirst = Y.encodeStateVectorFromUpdateV2(
        getStructureUpdate(stateAfterFirst!.content.update),
      );

      // Second write with same update -- should be a no-op
      await storage.handleUpdate(key, versionedUpdate(update));
      const stateAfterSecond = await storage.getDocument(key);
      const svAfterSecond = Y.encodeStateVectorFromUpdateV2(
        getStructureUpdate(stateAfterSecond!.content.update),
      );

      // State vector should not have changed
      expect(new Uint8Array(svAfterSecond)).toEqual(new Uint8Array(svAfterFirst));
    });
  });

  describe("getDocument", () => {
    it("should return null for non-existent document", async () => {
      const doc = await storage.getDocument("non-existent");
      expect(doc).toBeNull();
    });

    it("should return document with correct structure", async () => {
      const key = "test-doc-4";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Test content");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(key);
      expect(retrieved!.metadata).toBeDefined();
      expect(retrieved!.content).toBeDefined();
      expect(retrieved!.content.update).toBeInstanceOf(Uint8Array);
      expect(retrieved!.content.stateVector).toBeInstanceOf(Uint8Array);
    });

    it("should return document that can be applied to a new Y.Doc", async () => {
      const key = "test-doc-5";
      const originalDoc = new Y.Doc();
      const text = originalDoc.getText("content");
      text.insert(0, "Original content");
      const update = Y.encodeStateAsUpdateV2(originalDoc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();

      const newDoc = docFromUpdate(retrieved!.content.update);
      expect(newDoc.getText("content").toString()).toBe("Original content");
    });

    it("should return null if document doesn't exist when getting", async () => {
      const key = "test-doc-6";
      const doc = await storage.getDocument(key);

      expect(doc).toBeNull();
      expect(MemoryDocumentStorage.docs.has(key)).toBe(false);
    });

    it("getDocument returns full state after multiple updates", async () => {
      const key = "test-doc-full-state";

      // First update
      const doc1 = new Y.Doc();
      doc1.getText("content").insert(0, "First");
      const update1 = Y.encodeStateAsUpdateV2(doc1) as Update;
      await storage.handleUpdate(key, versionedUpdate(update1));

      // Second update building on the first
      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      doc2.getText("content").insert(5, " Second");
      const update2 = Y.encodeStateAsUpdateV2(doc2) as Update;
      await storage.handleUpdate(key, versionedUpdate(update2));

      // getDocument should return a document containing both updates
      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const fullDoc = docFromUpdate(retrieved!.content.update);
      expect(fullDoc.getText("content").toString()).toBe("First Second");
    });
  });

  describe("writeDocumentMetadata and getDocumentMetadata", () => {
    it("should write and retrieve metadata", async () => {
      const key = "test-doc-7";
      const metadata = {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: false,
      };

      await storage.writeDocumentMetadata(key, metadata);
      const retrieved = await storage.getDocumentMetadata(key);

      expect(retrieved.createdAt).toBe(1000);
      expect(retrieved.updatedAt).toBe(2000);
      expect(retrieved.encrypted).toBe(false);
    });

    it("should return default metadata for non-existent document", async () => {
      const key = "test-doc-8";
      const metadata = await storage.getDocumentMetadata(key);

      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(metadata.encrypted).toBe(false);
    });

    it("should normalize invalid metadata values", async () => {
      const key = "test-doc-9";
      // Write invalid metadata through the public API
      await storage.writeDocumentMetadata(key, {
        createdAt: "invalid" as any,
        updatedAt: "invalid" as any,
        encrypted: "invalid" as any,
      });

      const metadata = await storage.getDocumentMetadata(key);
      const _now = Date.now();

      expect(typeof metadata.createdAt).toBe("number");
      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(typeof metadata.updatedAt).toBe("number");
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(typeof metadata.encrypted).toBe("boolean");
      expect(metadata.encrypted).toBe(false);
    });
  });

  describe("deleteDocument", () => {
    it("should delete document and metadata", async () => {
      const key = "test-doc-10";
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: false,
      });

      expect(MemoryDocumentStorage.docs.has(key)).toBe(true);

      await storage.deleteDocument(key);

      expect(MemoryDocumentStorage.docs.has(key)).toBe(false);
    });

    it("should not fail if fileStorage is not provided", async () => {
      const key = "test-doc-12";
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));

      // Verify document exists before deletion
      expect(MemoryDocumentStorage.docs.has(key)).toBe(true);

      await storage.deleteDocument(key);

      // Verify document is deleted
      expect(MemoryDocumentStorage.docs.has(key)).toBe(false);
    });
  });

  describe("handleSyncStep1", () => {
    it("should return document with diff update", async () => {
      const key = "test-doc-13";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Full content");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));

      const emptyStateVector = getEmptyStateVector();

      const result = await storage.handleSyncStep1(key, emptyStateVector);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
      expect(result.content.update).toBeInstanceOf(Uint8Array);
      expect(result.content.stateVector).toBeInstanceOf(Uint8Array);
    });

    it("should return empty document for non-existent document", async () => {
      const key = "test-doc-14";
      const emptyStateVector = getEmptyStateVector();

      const result = await storage.handleSyncStep1(key, emptyStateVector);

      expect(result).not.toBeNull();
      expect(result.id).toBe(key);
    });

    it("sync step 1 with partial client returns only missing ops", async () => {
      const key = "test-doc-sync-partial";

      // First update
      const doc1 = new Y.Doc();
      doc1.getText("content").insert(0, "Hello");
      const update1 = Y.encodeStateAsUpdateV2(doc1) as Update;
      await storage.handleUpdate(key, versionedUpdate(update1));

      // Record the state vector after first update (the "partial" client)
      const partialSV = Y.encodeStateVector(doc1) as StateVector;

      // Second update building on the first
      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      doc2.getText("content").insert(5, " World");
      const update2 = Y.encodeStateAsUpdateV2(doc2) as Update;
      await storage.handleUpdate(key, versionedUpdate(update2));

      // Client sends partial state vector -- should get only the second update's ops
      const result = await storage.handleSyncStep1(key, partialSV);
      expect(result.content.update.length).toBeGreaterThan(0);

      // Apply the diff to a doc that already has update1
      const clientDoc = new Y.Doc();
      Y.applyUpdateV2(clientDoc, update1);
      Y.applyUpdateV2(clientDoc, getStructureUpdate(result.content.update));
      expect(clientDoc.getText("content").toString()).toBe("Hello World");
    });
  });

  describe("handleSyncStep2", () => {
    it("should apply sync step 2 update", async () => {
      const key = "test-doc-15";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Sync content");
      const v2 = Y.encodeStateAsUpdateV2(doc);
      const payload = encodeContentEncryptedPayload({
        structureUpdate: v2,
        encryptedSidecars: [],
      });
      const syncStep2: VersionedSyncStep2Update = {
        version: 2 as const,
        data: payload as unknown as SyncStep2UpdateV2,
      };

      await storage.handleSyncStep2(key, syncStep2);

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const newDoc = docFromUpdate(retrieved!.content.update);
      expect(newDoc.getText("content").toString()).toBe("Sync content");
    });
  });

  describe("transaction", () => {
    it("should execute transaction callback", async () => {
      const key = "test-doc-16";
      let executed = false;

      await storage.transaction(key, async () => {
        executed = true;
        return "result";
      });

      expect(executed).toBe(true);
    });

    it("should return transaction result", async () => {
      const key = "test-doc-17";
      const result = await storage.transaction(key, async () => {
        return "test-result";
      });

      expect(result).toBe("test-result");
    });
  });

  describe("attribution", () => {
    function makeAttribution(update: Update, userId: string): EncodedContentMap {
      // The server extracts content IDs from the V2 structure update inside the envelope.
      // For unencrypted, the structure update is the full V2 update.
      const contentIds = createContentIdsFromUpdate({
        version: 2,
        data: update,
      } as unknown as VersionedUpdate);
      return encodeContentMap(
        createContentMapFromContentIds(
          contentIds,
          [
            createContentAttribute("insert", userId),
            createContentAttribute("insertAt", Date.now()),
          ],
          [
            createContentAttribute("delete", userId),
            createContentAttribute("deleteAt", Date.now()),
          ],
        ),
      );
    }

    it("should store and retrieve attribution via handleUpdate", async () => {
      const key = "attr-doc-1";
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "Hello");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;
      const attribution = makeAttribution(update, "user-1");

      await storage.handleUpdate(key, versionedUpdate(update), attribution);

      const retrieved = await storage.retrieveAttribution(key);
      expect(retrieved).not.toBeNull();
      const map = decodeContentMap(retrieved!);
      expect(map.inserts.clients.size).toBeGreaterThan(0);
    });

    it("should return null when no attribution exists", async () => {
      const result = await storage.retrieveAttribution("nonexistent");
      expect(result).toBeNull();
    });

    it("should not store attribution when param is undefined", async () => {
      const key = "attr-doc-2";
      const doc = new Y.Doc();
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));

      const result = await storage.retrieveAttribution(key);
      expect(result).toBeNull();
    });

    it("should merge multiple attributions on retrieve", async () => {
      const key = "attr-doc-3";
      const doc1 = new Y.Doc();
      doc1.getText("content").insert(0, "Hello");
      const update1 = Y.encodeStateAsUpdateV2(doc1) as Update;

      await storage.handleUpdate(key, versionedUpdate(update1), makeAttribution(update1, "user-1"));

      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      doc2.getText("content").insert(5, " World");
      const update2 = Y.encodeStateAsUpdateV2(doc2) as Update;

      await storage.handleUpdate(key, versionedUpdate(update2), makeAttribution(update2, "user-2"));

      const retrieved = await storage.retrieveAttribution(key);
      expect(retrieved).not.toBeNull();
      const map = decodeContentMap(retrieved!);
      expect(map.inserts.clients.size).toBeGreaterThan(0);
    });

    it("should clean up attribution on deleteDocument", async () => {
      const key = "attr-doc-4";
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "Hello");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update), makeAttribution(update, "user-1"));
      expect(await storage.retrieveAttribution(key)).not.toBeNull();

      await storage.deleteDocument(key);
      expect(await storage.retrieveAttribution(key)).toBeNull();
    });

    // ── Caching: byte-identity + no re-decode per read ──────────────────────

    const asBytes = (b: EncodedContentMap): number[] => Array.from(b as Uint8Array);

    /** Reference: the pre-cache implementation's exact output, as a byte array. */
    function referenceMerge(list: EncodedContentMap[]): number[] {
      return Array.from(
        encodeContentMap(mergeContentMaps(list.map((m) => decodeContentMap(m)))) as Uint8Array,
      );
    }

    it("retrieve returns bytes identical to a full merge of all appended maps", async () => {
      const key = "attr-cache-bytes";
      const raw: EncodedContentMap[] = [];
      for (let i = 0; i < 5; i++) {
        const doc = new Y.Doc();
        doc.clientID = (i + 1) * 100;
        doc.getText("content").insert(0, `part-${i}`);
        const update = Y.encodeStateAsUpdateV2(doc) as Update;
        const attribution = makeAttribution(update, `user-${i}`);
        raw.push(attribution);
        await storage.handleUpdate(key, versionedUpdate(update), attribution);
      }

      const retrieved = await storage.retrieveAttribution(key);
      expect(retrieved).not.toBeNull();
      // Byte-identical to the naive full-merge-and-encode of every raw map.
      expect(asBytes(retrieved!)).toEqual(referenceMerge(raw));
    });

    it("repeated reads with no new appends do not re-decode/re-encode", async () => {
      const key = "attr-cache-repeat";
      for (let i = 0; i < 4; i++) {
        const doc = new Y.Doc();
        doc.clientID = (i + 1) * 100;
        doc.getText("content").insert(0, `part-${i}`);
        const update = Y.encodeStateAsUpdateV2(doc) as Update;
        await storage.handleUpdate(key, versionedUpdate(update), makeAttribution(update, `u-${i}`));
      }

      const first = await storage.retrieveAttribution(key);
      const second = await storage.retrieveAttribution(key);
      const third = await storage.retrieveAttribution(key);

      // Same object reference means no re-merge/re-encode happened: the cached
      // blob is served directly (the list was collapsed on the first read).
      expect(second).toBe(first);
      expect(third).toBe(first);
      // The raw list is collapsed to a single merged entry after the first read.
      expect(MemoryDocumentStorage.attributionMaps.get(key)!.length).toBe(1);
    });

    it("a read after a new append reflects the appended attribution", async () => {
      const key = "attr-cache-append";

      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getText("content").insert(0, "A");
      const updateA = Y.encodeStateAsUpdateV2(docA) as Update;
      await storage.handleUpdate(key, versionedUpdate(updateA), makeAttribution(updateA, "user-A"));

      const afterA = await storage.retrieveAttribution(key);
      const clientsAfterA = decodeContentMap(afterA!).inserts.clients.size;

      // Append a second, independent client's attribution.
      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getText("content").insert(0, "B");
      const updateB = Y.encodeStateAsUpdateV2(docB) as Update;
      const attrB = makeAttribution(updateB, "user-B");
      await storage.handleUpdate(key, versionedUpdate(updateB), attrB);

      const afterB = await storage.retrieveAttribution(key);
      // New content is reflected (a distinct client range appeared)...
      expect(afterB).not.toBe(afterA);
      expect(decodeContentMap(afterB!).inserts.clients.size).toBeGreaterThan(clientsAfterA);
      // ...and it still matches a naive full merge of both raw maps.
      expect(asBytes(afterB!)).toEqual(referenceMerge([afterA as EncodedContentMap, attrB]));
    });
  });
});

// ── Encrypted ───────────────────────────────────────────────────────────────

describe("MemoryDocumentStorage (encrypted)", () => {
  let storage: MemoryDocumentStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    MemoryDocumentStorage.attributionCache.clear();
    storage = new MemoryDocumentStorage(true);
  });

  // ── 1. Basic metadata ──────────────────────────────────────────────────────

  it("returns default metadata for missing document", async () => {
    const metadata = await storage.getDocumentMetadata("doc-1");
    expect(metadata.encrypted).toBe(true);
    expect(metadata.createdAt).toBeGreaterThan(0);
    expect(metadata.updatedAt).toBeGreaterThan(0);
  });

  // ── 2. Store and retrieve ──────────────────────────────────────────────────

  it("stores a content-encrypted update and persists state", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("key", "value");
    const v2Update = Y.encodeStateAsUpdateV2(doc);

    const payload = makeContentEncryptedUpdate(v2Update);
    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    const state = await storage.getDocumentState("doc-1");
    expect(state).not.toBeNull();
    expect(state!.update.length).toBeGreaterThan(0);
    expect(state!.sidecars.length).toBe(1);
  });

  // ── 3. Sync step 1 with empty client ───────────────────────────────────────

  it("sync step 1 with empty client returns full diff and all sidecars", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("hello", "world");
    const v2Update = Y.encodeStateAsUpdateV2(doc);

    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v2Update)));

    // Client has no state -- empty state vector
    const emptyDoc = new Y.Doc();
    const clientSV = Y.encodeStateVector(emptyDoc) as StateVector;

    const result = await storage.handleSyncStep1("doc-1", clientSV);
    expect(result).toBeDefined();

    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // The diff should contain the full structure update (client is empty)
    expect(decoded.structureUpdate.length).toBeGreaterThan(0);
    // All sidecars should be returned
    expect(decoded.encryptedSidecars.length).toBe(1);

    // Verify the returned state vector reflects the server state
    expect(result.content.stateVector.length).toBeGreaterThan(0);
  });

  it("sync step 1 with no document returns empty payload", async () => {
    const emptyDoc = new Y.Doc();
    const clientSV = Y.encodeStateVector(emptyDoc) as StateVector;

    const result = await storage.handleSyncStep1("nonexistent", clientSV);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );
    expect(decoded.structureUpdate.length).toBe(0);
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  // ── 4. Sync step 1 with up-to-date client ─────────────────────────────────

  it("sync step 1 with up-to-date client returns empty diff", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("x", 42);
    const v2Update = Y.encodeStateAsUpdateV2(doc);

    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v2Update)));

    // Client has the same state as the server
    const clientSV = Y.encodeStateVector(doc) as StateVector;

    const result = await storage.handleSyncStep1("doc-1", clientSV);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // diff of identical states should be empty (or very small: just the empty update header)
    // Y.diffUpdate returns a minimal update when there's nothing new
    const diffDoc = new Y.Doc();
    Y.applyUpdateV2(diffDoc, decoded.structureUpdate);
    // A fully up-to-date client should get an empty diff
    expect(diffDoc.getMap("root").size).toBe(0);
  });

  // ── 5. Sync step 1 with partial client ─────────────────────────────────────

  it("sync step 1 with partial client returns only missing ops", async () => {
    // Create doc with first update
    const doc1 = new Y.Doc();
    doc1.getMap("root").set("a", 1);
    const update1 = Y.encodeStateAsUpdateV2(doc1);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update1)));

    // Record the state vector after first update (this is the "partial" client)
    const partialSV = Y.encodeStateVector(doc1) as StateVector;

    // Create second update with more data
    const doc2 = new Y.Doc();
    Y.applyUpdateV2(doc2, update1);
    doc2.getMap("root").set("b", 2);
    const update2 = Y.encodeStateAsUpdateV2(doc2, Y.encodeStateVector(doc1));
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update2)));

    // Client sends the partial state vector -- should get only the second update's ops
    const result = await storage.handleSyncStep1("doc-1", partialSV);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // The diff should contain only the missing ops
    expect(decoded.structureUpdate.length).toBeGreaterThan(0);

    // Restore the original content from the sidecar entries and verify
    const allDecoded = decoded.encryptedSidecars.map((s) =>
      decodeSidecar(s as unknown as Uint8Array),
    );
    const restored = restoreContent(decoded.structureUpdate, mergeSidecars(allDecoded));

    // Apply update1 + the restored diff to a new doc
    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, update1);
    Y.applyUpdateV2(clientDoc, restored);
    expect(decoded.structureUpdate.byteLength).toBeGreaterThan(0);

    // Also verify the full server state has both keys by checking getDocument
    const fullDoc = await storage.getDocument("doc-1");
    expect(fullDoc).not.toBeNull();
    const fullDecoded = decodeContentEncryptedPayload(
      fullDoc!.content.update as unknown as EncryptedUpdatePayload,
    );
    const fullAllDecoded = fullDecoded.encryptedSidecars.map((s) =>
      decodeSidecar(s as unknown as Uint8Array),
    );
    const fullRestored = restoreContent(fullDecoded.structureUpdate, mergeSidecars(fullAllDecoded));
    const verifyDoc = new Y.Doc();
    Y.applyUpdateV2(verifyDoc, fullRestored);
    expect(verifyDoc.getMap("root").get("a")).toBe(1);
    expect(verifyDoc.getMap("root").get("b")).toBe(2);
  });

  // ── 6. Duplicate update is deduped ─────────────────────────────────────────

  it("duplicate update is CRDT-idempotent (state vector unchanged)", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("key", "value");
    const v2Update = Y.encodeStateAsUpdateV2(doc);
    const payload = makeContentEncryptedUpdate(v2Update);

    // First time -- should create state
    await storage.handleUpdate("doc-1", envelopeUpdate(payload));
    const stateAfterFirst = await storage.getDocumentState("doc-1");
    expect(stateAfterFirst).not.toBeNull();
    const svAfterFirst = Y.encodeStateVectorFromUpdateV2(stateAfterFirst!.update);

    // Second time with same update -- state vector should not change
    await storage.handleUpdate("doc-1", envelopeUpdate(payload));
    const stateAfterSecond = await storage.getDocumentState("doc-1");
    const svAfterSecond = Y.encodeStateVectorFromUpdateV2(stateAfterSecond!.update);

    expect(new Uint8Array(svAfterSecond)).toEqual(new Uint8Array(svAfterFirst));
    // Sidecars may accumulate on duplicate ciphertexts — cheap dedup at
    // write time costs an O(doc-size) byte compare. Compaction is the
    // mechanism that collapses redundant sidecars.
  });

  // ── 7. Multi-client updates merge correctly ────────────────────────────────

  it("multi-client updates merge correctly", async () => {
    // Client A creates an update
    const docA = new Y.Doc();
    docA.getMap("root").set("fromA", "hello");
    const updateA = Y.encodeStateAsUpdateV2(docA);

    // Client B creates an independent update
    const docB = new Y.Doc();
    docB.getMap("root").set("fromB", "world");
    const updateB = Y.encodeStateAsUpdateV2(docB);

    // Both updates are stored
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateA)));

    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateB)));

    // Verify the merged state includes both
    const state = await storage.getDocumentState("doc-1");
    expect(state).not.toBeNull();

    // The update should be a valid V2 merge of both
    const mergedDoc = new Y.Doc();
    Y.applyUpdateV2(mergedDoc, state!.update);
    // Both sidecars should be accumulated
    expect(state!.sidecars.length).toBe(2);
  });

  // ── 8. getDocument returns full state ──────────────────────────────────────

  it("getDocument returns full state with merged structure and all sidecars", async () => {
    // Store two updates
    const doc1 = new Y.Doc();
    doc1.getMap("root").set("a", 1);
    const update1 = Y.encodeStateAsUpdateV2(doc1);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update1)));

    const doc2 = new Y.Doc();
    Y.applyUpdateV2(doc2, update1);
    doc2.getMap("root").set("b", 2);
    const update2 = Y.encodeStateAsUpdateV2(doc2, Y.encodeStateVector(doc1));
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update2)));

    const document = await storage.getDocument("doc-1");
    expect(document).not.toBeNull();

    const decoded = decodeContentEncryptedPayload(
      document!.content.update as unknown as EncryptedUpdatePayload,
    );

    // Full structure update (not a diff)
    expect(decoded.structureUpdate.length).toBeGreaterThan(0);
    // All sidecars accumulated
    expect(decoded.encryptedSidecars.length).toBe(2);

    // State vector should reflect the merged state
    expect(document!.content.stateVector.length).toBeGreaterThan(0);

    // Verify the structure update can be applied
    const verifyDoc = new Y.Doc();
    Y.applyUpdateV2(verifyDoc, decoded.structureUpdate);
  });

  it("getDocument returns null for missing document", async () => {
    const result = await storage.getDocument("nonexistent");
    expect(result).toBeNull();
  });

  // ── 9. Attribution ─────────────────────────────────────────────────────────

  describe("attribution", () => {
    function makeAttribution(userId: string, clientId = 1, clock = 0, len = 1): EncodedContentMap {
      const inserts = new IdSet();
      inserts.add(clientId, clock, len);
      const contentIds = createContentIds(inserts, new IdSet());
      return encodeContentMap(
        createContentMapFromContentIds(
          contentIds,
          [
            createContentAttribute("insert", userId),
            createContentAttribute("insertAt", Date.now()),
          ],
          [],
        ),
      );
    }

    it("stores and retrieves attribution via handleUpdate", async () => {
      const doc = new Y.Doc();
      doc.getMap("root").set("key", "value");
      const v2Update = Y.encodeStateAsUpdateV2(doc);
      const payload = makeContentEncryptedUpdate(v2Update);
      const attribution = makeAttribution("user-1");

      await storage.handleUpdate("doc-1", envelopeUpdate(payload), attribution);

      const retrieved = await storage.retrieveAttribution("doc-1");
      expect(retrieved).not.toBeNull();
      const map = decodeContentMap(retrieved!);
      expect(map.inserts.clients.size).toBeGreaterThan(0);
    });

    it("returns null when no attribution exists", async () => {
      const result = await storage.retrieveAttribution("nonexistent");
      expect(result).toBeNull();
    });

    it("does not store attribution when param is undefined", async () => {
      const doc = new Y.Doc();
      doc.getMap("root").set("key", "value");
      const v2Update = Y.encodeStateAsUpdateV2(doc);
      const payload = makeContentEncryptedUpdate(v2Update);

      await storage.handleUpdate("doc-1", envelopeUpdate(payload));

      const result = await storage.retrieveAttribution("doc-1");
      expect(result).toBeNull();
    });

    it("merges multiple attributions on retrieve", async () => {
      // First update with user-1 attribution
      const doc1 = new Y.Doc();
      doc1.getMap("root").set("a", 1);
      const update1 = Y.encodeStateAsUpdateV2(doc1);
      const payload1 = makeContentEncryptedUpdate(update1);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(payload1),
        makeAttribution("user-1", 1, 0, 5),
      );

      // Second update with user-2 attribution (different client ID for independent update)
      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      doc2.getMap("root").set("b", 2);
      const update2 = Y.encodeStateAsUpdateV2(doc2, Y.encodeStateVector(doc1));
      const payload2 = makeContentEncryptedUpdate(update2);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(payload2),
        makeAttribution("user-2", 2, 0, 3),
      );

      const retrieved = await storage.retrieveAttribution("doc-1");
      expect(retrieved).not.toBeNull();
      const map = decodeContentMap(retrieved!);
      expect(map.inserts.clients.size).toBe(2);
    });

    it("cleans up attribution on deleteDocument", async () => {
      const doc = new Y.Doc();
      doc.getMap("root").set("key", "value");
      const v2Update = Y.encodeStateAsUpdateV2(doc);
      const payload = makeContentEncryptedUpdate(v2Update);

      await storage.handleUpdate("doc-1", envelopeUpdate(payload), makeAttribution("user-1"));
      expect(await storage.retrieveAttribution("doc-1")).not.toBeNull();

      await storage.deleteDocument("doc-1");
      expect(await storage.retrieveAttribution("doc-1")).toBeNull();
    });
  });

  // ── 10. Delete document ────────────────────────────────────────────────────

  it("delete document removes all data", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("key", "value");
    const v2Update = Y.encodeStateAsUpdateV2(doc);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v2Update)));

    // Verify data exists
    expect(await storage.getDocumentState("doc-1")).not.toBeNull();
    expect(await storage.getDocument("doc-1")).not.toBeNull();

    // Delete
    await storage.deleteDocument("doc-1");

    // Verify all data is gone
    expect(await storage.getDocumentState("doc-1")).toBeNull();
    expect(await storage.getDocument("doc-1")).toBeNull();
  });

  // ── 8a. Sidecar filtering on partial sync ───────────────────────────────────

  it("sync step 1 filters sidecars to only those needed for the diff", async () => {
    // Client A creates update
    const docA = new Y.Doc();
    docA.clientID = 100;
    docA.getMap("root").set("fromA", "hello");
    const updateA = Y.encodeStateAsUpdateV2(docA);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateA)));

    // Client B creates independent update
    const docB = new Y.Doc();
    docB.clientID = 200;
    docB.getMap("root").set("fromB", "world");
    const updateB = Y.encodeStateAsUpdateV2(docB);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateB)));

    // Verify we accumulated 2 sidecars
    const state = await storage.getDocumentState("doc-1");
    expect(state!.sidecars.length).toBe(2);

    // A client that already has client A's state syncs -- should only get B's sidecar
    const svA = Y.encodeStateVector(docA) as StateVector;
    const result = await storage.handleSyncStep1("doc-1", svA);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // Only 1 sidecar (B's), not both
    expect(decoded.encryptedSidecars.length).toBe(1);

    // Verify the sidecar + structure update produce correct content
    const allDecoded = decoded.encryptedSidecars.map((s) =>
      decodeSidecar(s as unknown as Uint8Array),
    );
    const restored = restoreContent(decoded.structureUpdate, mergeSidecars(allDecoded));

    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, updateA); // client already has A
    Y.applyUpdateV2(clientDoc, restored); // apply the diff
    expect(clientDoc.getMap("root").get("fromB")).toBe("world");
  });

  it("sync step 1 returns all sidecars for empty client", async () => {
    const docA = new Y.Doc();
    docA.clientID = 100;
    docA.getMap("root").set("a", 1);
    await storage.handleUpdate(
      "doc-1",
      envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docA))),
    );

    const docB = new Y.Doc();
    docB.clientID = 200;
    docB.getMap("root").set("b", 2);
    await storage.handleUpdate(
      "doc-1",
      envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docB))),
    );

    const emptySV = Y.encodeStateVector(new Y.Doc()) as StateVector;
    const result = await storage.handleSyncStep1("doc-1", emptySV);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // Empty client needs everything -- both sidecars
    expect(decoded.encryptedSidecars.length).toBe(2);
  });

  it("sync step 1 returns no sidecars for up-to-date client", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("x", 42);
    const v2Update = Y.encodeStateAsUpdateV2(doc);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v2Update)));

    const clientSV = Y.encodeStateVector(doc) as StateVector;
    const result = await storage.handleSyncStep1("doc-1", clientSV);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // Up-to-date client should get zero sidecars
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  // ── handleSyncStep2 delegates correctly ───────────────────────────────────

  it("handleSyncStep2 stores update", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("synced", true);
    const v2Update = Y.encodeStateAsUpdateV2(doc);
    const payload = makeContentEncryptedUpdate(v2Update);

    await storage.handleSyncStep2("doc-1", {
      version: 2,
      data: payload,
    } as unknown as VersionedSyncStep2Update);

    const document = await storage.getDocument("doc-1");
    expect(document).not.toBeNull();
  });

  it("handleSyncStep2 is CRDT-idempotent on duplicates", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("synced", true);
    const v2Update = Y.encodeStateAsUpdateV2(doc);
    const payload = makeContentEncryptedUpdate(v2Update);

    await storage.handleSyncStep2("doc-1", {
      version: 2,
      data: payload,
    } as unknown as VersionedSyncStep2Update);

    const stateAfterFirst = await storage.getDocumentState("doc-1");
    const svAfterFirst = Y.encodeStateVectorFromUpdateV2(stateAfterFirst!.update);

    await storage.handleSyncStep2("doc-1", {
      version: 2,
      data: payload,
    } as unknown as VersionedSyncStep2Update);

    const stateAfterSecond = await storage.getDocumentState("doc-1");
    const svAfterSecond = Y.encodeStateVectorFromUpdateV2(stateAfterSecond!.update);
    expect(new Uint8Array(svAfterSecond)).toEqual(new Uint8Array(svAfterFirst));
  });

  // ── 11. Compaction ─────────────────────────────────────────────────────────

  describe("compaction", () => {
    it("replaces multiple sidecars with a single compacted sidecar", async () => {
      // Store two updates from different clients
      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getMap("root").set("a", 1);
      const updateA = Y.encodeStateAsUpdateV2(docA);
      await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateA)));

      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getMap("root").set("b", 2);
      const updateB = Y.encodeStateAsUpdateV2(docB);
      await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateB)));

      // Verify 2 sidecars accumulated
      let state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(2);

      // Get the base state vector for optimistic concurrency
      // State is stored as V2, so use V2 API
      const baseSV = Y.encodeStateVectorFromUpdateV2(state!.update);

      // Simulate client-side compaction: merge all sidecar entries into one
      const allDecoded = state!.sidecars.map((s) =>
        decodeSidecar(s.encrypted as unknown as Uint8Array),
      );
      const merged = mergeSidecars(allDecoded);
      const allEntries = merged.entries;
      const compactedBytes = encodeSidecar(merged);
      const encrypted = compactedBytes as EncryptedBinary;
      const compactedSidecar = {
        encrypted,
        index: [
          {
            clientId: 100,
            minClock: 0,
            maxClock: allEntries
              .filter((e) => e.clientId === 100)
              .reduce((max, e) => Math.max(max, e.clock), 0),
          },
          {
            clientId: 200,
            minClock: 0,
            maxClock: allEntries
              .filter((e) => e.clientId === 200)
              .reduce((max, e) => Math.max(max, e.clock), 0),
          },
        ],
        hash: await hashSidecar(encrypted),
      };

      const accepted = await storage.handleCompaction("doc-1", compactedSidecar, baseSV);
      expect(accepted).toBe(true);

      // Verify only 1 sidecar remains
      state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(1);

      // Verify the compacted sidecar contains all entries
      const { entries } = decodeSidecar(state!.sidecars[0].encrypted as unknown as Uint8Array);
      expect(entries.length).toBe(allEntries.length);
    });

    it("rejects compaction when state has changed (stale baseSV)", async () => {
      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getMap("root").set("a", 1);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docA))),
      );

      const state = await storage.getDocumentState("doc-1");
      const baseSV = Y.encodeStateVectorFromUpdateV2(state!.update);

      // Another update arrives while client is compacting
      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getMap("root").set("b", 2);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docB))),
      );

      // Compaction with stale baseSV should be rejected
      const dummyEncrypted = encodeSidecar({
        entries: [],
        dictionary: new Map(),
      }) as EncryptedBinary;
      const compactedSidecar = {
        encrypted: dummyEncrypted,
        index: [],
        hash: await hashSidecar(dummyEncrypted),
      };
      const accepted = await storage.handleCompaction("doc-1", compactedSidecar, baseSV);
      expect(accepted).toBe(false);

      // Sidecars should be unchanged (still 2)
      const currentState = await storage.getDocumentState("doc-1");
      expect(currentState!.sidecars.length).toBe(2);
    });

    it("rejects compaction for nonexistent document", async () => {
      const dummyEncrypted = encodeSidecar({
        entries: [],
        dictionary: new Map(),
      }) as EncryptedBinary;
      const compactedSidecar = {
        encrypted: dummyEncrypted,
        index: [],
        hash: await hashSidecar(dummyEncrypted),
      };
      const accepted = await storage.handleCompaction(
        "nonexistent",
        compactedSidecar,
        new Uint8Array(0),
      );
      expect(accepted).toBe(false);
    });
  });

  // ── 12. Inline compaction via handleUpdate ──────────────────────────────────

  describe("inline compaction (compaction piggy-backed on update)", () => {
    function makeCompactionPayload(
      v2Update: Uint8Array,
      compaction: import("teleportal/protocol/encryption").SidecarCompaction,
    ): EncryptedUpdatePayload {
      const { update: structureUpdate, sidecar } = stripContent(v2Update, 2);
      const sidecarBytes = encodeSidecar(sidecar);
      return encodeContentEncryptedPayload({
        structureUpdate,
        encryptedSidecars: [sidecarBytes as EncryptedBinary],
        compaction,
      }) as EncryptedUpdatePayload;
    }

    async function buildCompaction(
      sidecars: { encrypted: EncryptedBinary }[],
    ): Promise<import("teleportal/protocol/encryption").SidecarCompaction> {
      const allDecoded = sidecars.map((s) => decodeSidecar(s.encrypted as unknown as Uint8Array));
      const merged = mergeSidecars(allDecoded);
      const compactedBytes = encodeSidecar(merged);
      const encrypted = compactedBytes as EncryptedBinary;
      const { buildSidecarIndex } =
        require("teleportal/protocol/encryption") as typeof import("teleportal/protocol/encryption");
      return {
        sidecar: encrypted,
        index: buildSidecarIndex(merged.entries),
        hash: await hashSidecar(encrypted),
        sourceHashes: await Promise.all(sidecars.map((s) => hashSidecar(s.encrypted))),
      };
    }

    it("replaces matched sidecars when all sourceHashes match", async () => {
      // Accumulate 3 sidecars from different clients
      for (let i = 1; i <= 3; i++) {
        const doc = new Y.Doc();
        doc.clientID = i * 100;
        doc.getMap("root").set(`key-${i}`, i);
        await storage.handleUpdate(
          "doc-1",
          envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(doc))),
        );
      }

      let state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(3);

      // Build compaction from the 3 stored sidecars
      const compaction = await buildCompaction(state!.sidecars);

      // Send a new update with compaction piggy-backed
      const docNew = new Y.Doc();
      docNew.clientID = 400;
      docNew.getMap("root").set("new-key", 4);
      const v2 = Y.encodeStateAsUpdateV2(docNew);

      await storage.handleUpdate("doc-1", envelopeUpdate(makeCompactionPayload(v2, compaction)));

      state = await storage.getDocumentState("doc-1");
      // 1 compacted + 1 new from the update = 2
      expect(state!.sidecars.length).toBe(2);

      // Verify compacted sidecar has the correct hash
      expect(state!.sidecars[0].hash).toEqual(compaction.hash);
    });

    it("keeps concurrent sidecars alongside compaction", async () => {
      // Accumulate 2 sidecars
      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getMap("root").set("a", 1);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docA))),
      );

      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getMap("root").set("b", 2);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docB))),
      );

      // Snapshot the 2 sidecars for compaction
      let state = await storage.getDocumentState("doc-1");
      const compaction = await buildCompaction(state!.sidecars);

      // Concurrent write arrives BEFORE compaction is applied
      const docC = new Y.Doc();
      docC.clientID = 300;
      docC.getMap("root").set("c", 3);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docC))),
      );

      state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(3);

      // Now apply compaction — it should replace sidecars 0 and 1 but keep sidecar 2
      const docNew = new Y.Doc();
      docNew.clientID = 400;
      docNew.getMap("root").set("d", 4);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(Y.encodeStateAsUpdateV2(docNew), compaction)),
      );

      state = await storage.getDocumentState("doc-1");
      // 1 compacted + 1 concurrent (docC) + 1 new (docNew) = 3
      expect(state!.sidecars.length).toBe(3);

      // First sidecar is the compacted one
      expect(state!.sidecars[0].hash).toEqual(compaction.hash);
    });

    it("skips compaction when a source sidecar is missing (concurrent compaction)", async () => {
      // Accumulate 2 sidecars
      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getMap("root").set("a", 1);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docA))),
      );

      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getMap("root").set("b", 2);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docB))),
      );

      // Client 1 snapshots sidecars for compaction
      let state = await storage.getDocumentState("doc-1");
      const compaction = await buildCompaction(state!.sidecars);

      // Client 2 already compacted via handleCompaction — replaces both sidecars
      const allDecoded = state!.sidecars.map((s) =>
        decodeSidecar(s.encrypted as unknown as Uint8Array),
      );
      const merged = mergeSidecars(allDecoded);
      const otherCompactedBytes = encodeSidecar(merged) as EncryptedBinary;
      await storage.handleCompaction(
        "doc-1",
        {
          encrypted: otherCompactedBytes,
          index: [],
          hash: await hashSidecar(otherCompactedBytes),
        },
        Y.encodeStateVectorFromUpdateV2(state!.update),
      );

      state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(1);

      // Client 1's compaction now has stale sourceHashes — should be skipped
      const docNew = new Y.Doc();
      docNew.clientID = 300;
      docNew.getMap("root").set("c", 3);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(Y.encodeStateAsUpdateV2(docNew), compaction)),
      );

      state = await storage.getDocumentState("doc-1");
      // Compaction skipped: 1 existing (from other compaction) + 1 new = 2
      expect(state!.sidecars.length).toBe(2);
    });

    it("compaction is ignored when document has no existing state", async () => {
      const dummyEncrypted = encodeSidecar({
        entries: [],
        dictionary: new Map(),
      }) as EncryptedBinary;
      const compaction: import("teleportal/protocol/encryption").SidecarCompaction = {
        sidecar: dummyEncrypted,
        index: [],
        hash: await hashSidecar(dummyEncrypted),
        sourceHashes: [await hashSidecar(dummyEncrypted)],
      };

      const doc = new Y.Doc();
      doc.clientID = 100;
      doc.getMap("root").set("a", 1);

      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(Y.encodeStateAsUpdateV2(doc), compaction)),
      );

      // First update — no existing state, so compaction is ignored, only new sidecar stored
      const state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(1);
    });

    it("stores hashes on sidecars during normal handleUpdate", async () => {
      const doc = new Y.Doc();
      doc.clientID = 100;
      doc.getMap("root").set("key", "value");
      const v2 = Y.encodeStateAsUpdateV2(doc);
      const payload = makeContentEncryptedUpdate(v2);

      await storage.handleUpdate("doc-1", envelopeUpdate(payload));

      const state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(1);

      // Hash should be a 32-byte SHA-256 digest
      const sidecar = state!.sidecars[0];
      expect(sidecar.hash).toBeInstanceOf(Uint8Array);
      expect(sidecar.hash.length).toBe(32);

      // Hash should match recomputation
      expect(sidecar.hash).toEqual(await hashSidecar(sidecar.encrypted));
    });

    it("processes compaction even when the update itself is a no-op (new client with no local changes)", async () => {
      // Build the original updates and store them
      const updates: Uint8Array[] = [];
      for (let i = 1; i <= 3; i++) {
        const doc = new Y.Doc();
        doc.clientID = i * 100;
        doc.getMap("root").set(`key-${i}`, i);
        const v2 = Y.encodeStateAsUpdateV2(doc);
        updates.push(v2);
        await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v2)));
      }

      let state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(3);

      const compaction = await buildCompaction(state!.sidecars);

      // Simulate a new client: apply the same updates to get identical state,
      // then compute a diff against the server's SV — should produce a no-op update
      const clientDoc = new Y.Doc();
      for (const u of updates) {
        Y.applyUpdateV2(clientDoc, u);
      }
      const serverSV = Y.encodeStateVectorFromUpdateV2(state!.update);
      const noOpDiff = Y.encodeStateAsUpdateV2(clientDoc, serverSV);

      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(noOpDiff, compaction)),
      );

      state = await storage.getDocumentState("doc-1");
      // Compaction applied, no-op diff didn't add a sidecar → exactly 1 compacted sidecar
      expect(state!.sidecars.length).toBe(1);
      expect(state!.sidecars[0].hash).toEqual(compaction.hash);
    });

    it("next client connecting after compaction receives only the compacted sidecar", async () => {
      // Accumulate 3 sidecars from different clients
      for (let i = 1; i <= 3; i++) {
        const doc = new Y.Doc();
        doc.clientID = i * 100;
        doc.getMap("root").set(`key-${i}`, i);
        await storage.handleUpdate(
          "doc-1",
          envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(doc))),
        );
      }

      // Verify 3 sidecars accumulated
      let state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(3);
      const compaction = await buildCompaction(state!.sidecars);

      // Client A sends back sync-step-2 with no-op diff + compaction
      const updates = [];
      for (let i = 1; i <= 3; i++) {
        const doc = new Y.Doc();
        doc.clientID = i * 100;
        doc.getMap("root").set(`key-${i}`, i);
        updates.push(Y.encodeStateAsUpdateV2(doc));
      }
      const clientADoc = new Y.Doc();
      for (const u of updates) Y.applyUpdateV2(clientADoc, u);
      const serverSV = Y.encodeStateVectorFromUpdateV2(state!.update);
      const noOpDiff = Y.encodeStateAsUpdateV2(clientADoc, serverSV);

      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(noOpDiff, compaction)),
      );

      // After compaction: should have exactly 1 sidecar
      state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(1);

      // Now simulate Client B connecting: server calls handleSyncStep1 which
      // uses getDocument() → encodes sidecars into the payload
      const doc = await storage.getDocument("doc-1");
      expect(doc).not.toBeNull();
      const payload = decodeContentEncryptedPayload(
        doc!.content.update as unknown as EncryptedUpdatePayload,
      );

      // Client B should receive exactly 1 sidecar (the compacted one)
      expect(payload.encryptedSidecars.length).toBe(1);

      // Verify the content is intact: decode the compacted sidecar and restore
      const sidecar = decodeSidecar(payload.encryptedSidecars[0] as unknown as Uint8Array);
      const restored = restoreContent(payload.structureUpdate, sidecar);
      const verifyDoc = new Y.Doc();
      Y.applyUpdateV2(verifyDoc, restored);
      expect(verifyDoc.getMap("root").get("key-1")).toBe(1);
      expect(verifyDoc.getMap("root").get("key-2")).toBe(2);
      expect(verifyDoc.getMap("root").get("key-3")).toBe(3);
    });

    it("update without compaction appends sidecars normally", async () => {
      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getMap("root").set("a", 1);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docA))),
      );

      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getMap("root").set("b", 2);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(docB))),
      );

      const state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(2);
      // Each sidecar has its own hash
      expect(state!.sidecars[0].hash).not.toEqual(state!.sidecars[1].hash);
    });
  });

  // ── Empty structure update is rejected ─────────────────────────────────────

  it("rejects update with empty structure update", async () => {
    const payload = encodeContentEncryptedPayload({
      structureUpdate: new Uint8Array(0),
      encryptedSidecars: [],
    }) as EncryptedUpdatePayload;

    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    // Empty structure update should be silently ignored -- no state created
    const state = await storage.getDocumentState("doc-1");
    expect(state).toBeNull();
  });
});

// ── deleteDocument routes through custom options ────────────────────────────

describe("MemoryDocumentStorage with custom backing options", () => {
  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    MemoryDocumentStorage.attributionCache.clear();
  });

  it("deletes from the custom backing store, not the static map", async () => {
    // A storage backed by its own Map (as offline persistence does) must have
    // deleteDocument remove from that Map — not the static MemoryDocumentStorage.docs.
    const backing = new Map<string, any>();
    const storage = new MemoryDocumentStorage(false, {
      write: async (key, doc) => {
        backing.set(key, doc);
      },
      fetch: async (key) => backing.get(key),
      delete: async (key) => {
        backing.delete(key);
      },
    });

    const doc = new Y.Doc();
    doc.getText("content").insert(0, "Hello");
    await storage.handleUpdate("doc-1", versionedUpdate(Y.encodeStateAsUpdateV2(doc) as Update));
    expect(backing.has("doc-1")).toBe(true);

    await storage.deleteDocument("doc-1");

    expect(backing.has("doc-1")).toBe(false);
    expect(await storage.getDocumentState("doc-1")).toBeNull();
  });
});
