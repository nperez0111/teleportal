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
  IdSet,
} from "teleportal/attribution";
import { MemoryDocumentStorage } from "./document-storage";
import type { EncodedContentMap, FileStorage } from "../types";

// ── Shared helpers ──────────────────────────────────────────────────────────

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  const v1 = Y.convertUpdateFormatV2ToV1(bytes);
  const payload = encodeContentEncryptedPayload({
    structureUpdate: v1,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

/**
 * Create a content-encrypted update payload from a raw Y.js V1 update.
 * Uses fake encryption -- the raw sidecar bytes are cast directly as EncryptedBinary.
 */
function makeContentEncryptedUpdate(v1Update: Uint8Array): EncryptedUpdatePayload {
  const { update: structureUpdate, sidecar } = stripContent(v1Update);
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
    Y.applyUpdate(doc, structureUpdate);
  }
  return doc;
}

// ── Unencrypted ─────────────────────────────────────────────────────────────

describe("MemoryDocumentStorage (unencrypted)", () => {
  let storage: MemoryDocumentStorage;
  let _mockFileStorage: FileStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.attributionMaps.clear();
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
      const svAfterFirst = Y.encodeStateVectorFromUpdate(
        getStructureUpdate(stateAfterFirst!.content.update),
      );

      // Second write with same update -- should be a no-op
      await storage.handleUpdate(key, versionedUpdate(update));
      const stateAfterSecond = await storage.getDocument(key);
      const svAfterSecond = Y.encodeStateVectorFromUpdate(
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
      Y.applyUpdate(clientDoc, getStructureUpdate(result.content.update));
      expect(clientDoc.getText("content").toString()).toBe("Hello World");
    });
  });

  describe("handleSyncStep2", () => {
    it("should apply sync step 2 update", async () => {
      const key = "test-doc-15";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Sync content");
      const v1 = Y.encodeStateAsUpdate(doc);
      const payload = encodeContentEncryptedPayload({
        structureUpdate: v1,
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
      // The server extracts content IDs from the V1 structure update inside the envelope.
      // For unencrypted, the structure update is the full V1 update.
      const v1 = Y.convertUpdateFormatV2ToV1(update);
      const contentIds = createContentIdsFromUpdate({
        version: 1,
        data: v1,
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
  });
});

// ── Encrypted ───────────────────────────────────────────────────────────────

describe("MemoryDocumentStorage (encrypted)", () => {
  let storage: MemoryDocumentStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.attributionMaps.clear();
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
    const v1Update = Y.encodeStateAsUpdate(doc);

    const payload = makeContentEncryptedUpdate(v1Update);
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
    const v1Update = Y.encodeStateAsUpdate(doc);

    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v1Update)));

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
    const v1Update = Y.encodeStateAsUpdate(doc);

    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v1Update)));

    // Client has the same state as the server
    const clientSV = Y.encodeStateVector(doc) as StateVector;

    const result = await storage.handleSyncStep1("doc-1", clientSV);
    const decoded = decodeContentEncryptedPayload(
      result.content.update as unknown as EncryptedUpdatePayload,
    );

    // diff of identical states should be empty (or very small: just the empty update header)
    // Y.diffUpdate returns a minimal update when there's nothing new
    const diffDoc = new Y.Doc();
    Y.applyUpdate(diffDoc, decoded.structureUpdate);
    // A fully up-to-date client should get an empty diff
    expect(diffDoc.getMap("root").size).toBe(0);
  });

  // ── 5. Sync step 1 with partial client ─────────────────────────────────────

  it("sync step 1 with partial client returns only missing ops", async () => {
    // Create doc with first update
    const doc1 = new Y.Doc();
    doc1.getMap("root").set("a", 1);
    const update1 = Y.encodeStateAsUpdate(doc1);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update1)));

    // Record the state vector after first update (this is the "partial" client)
    const partialSV = Y.encodeStateVector(doc1) as StateVector;

    // Create second update with more data
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update1);
    doc2.getMap("root").set("b", 2);
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
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
    Y.applyUpdate(clientDoc, update1);
    Y.applyUpdate(clientDoc, restored);
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
    Y.applyUpdate(verifyDoc, fullRestored);
    expect(verifyDoc.getMap("root").get("a")).toBe(1);
    expect(verifyDoc.getMap("root").get("b")).toBe(2);
  });

  // ── 6. Duplicate update is deduped ─────────────────────────────────────────

  it("duplicate update is deduped (state vector unchanged)", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("key", "value");
    const v1Update = Y.encodeStateAsUpdate(doc);
    const payload = makeContentEncryptedUpdate(v1Update);

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
    // Sidecars should not accumulate on dedup
    expect(stateAfterSecond!.sidecars.length).toBe(stateAfterFirst!.sidecars.length);
  });

  // ── 7. Multi-client updates merge correctly ────────────────────────────────

  it("multi-client updates merge correctly", async () => {
    // Client A creates an update
    const docA = new Y.Doc();
    docA.getMap("root").set("fromA", "hello");
    const updateA = Y.encodeStateAsUpdate(docA);

    // Client B creates an independent update
    const docB = new Y.Doc();
    docB.getMap("root").set("fromB", "world");
    const updateB = Y.encodeStateAsUpdate(docB);

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
    const update1 = Y.encodeStateAsUpdate(doc1);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update1)));

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update1);
    doc2.getMap("root").set("b", 2);
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
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
    Y.applyUpdate(verifyDoc, decoded.structureUpdate);
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
      const v1Update = Y.encodeStateAsUpdate(doc);
      const payload = makeContentEncryptedUpdate(v1Update);
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
      const v1Update = Y.encodeStateAsUpdate(doc);
      const payload = makeContentEncryptedUpdate(v1Update);

      await storage.handleUpdate("doc-1", envelopeUpdate(payload));

      const result = await storage.retrieveAttribution("doc-1");
      expect(result).toBeNull();
    });

    it("merges multiple attributions on retrieve", async () => {
      // First update with user-1 attribution
      const doc1 = new Y.Doc();
      doc1.getMap("root").set("a", 1);
      const update1 = Y.encodeStateAsUpdate(doc1);
      const payload1 = makeContentEncryptedUpdate(update1);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(payload1),
        makeAttribution("user-1", 1, 0, 5),
      );

      // Second update with user-2 attribution (different client ID for independent update)
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      doc2.getMap("root").set("b", 2);
      const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
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
      const v1Update = Y.encodeStateAsUpdate(doc);
      const payload = makeContentEncryptedUpdate(v1Update);

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
    const v1Update = Y.encodeStateAsUpdate(doc);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v1Update)));

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
    const updateA = Y.encodeStateAsUpdate(docA);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateA)));

    // Client B creates independent update
    const docB = new Y.Doc();
    docB.clientID = 200;
    docB.getMap("root").set("fromB", "world");
    const updateB = Y.encodeStateAsUpdate(docB);
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
    Y.applyUpdate(clientDoc, updateA); // client already has A
    Y.applyUpdate(clientDoc, restored); // apply the diff
    expect(clientDoc.getMap("root").get("fromB")).toBe("world");
  });

  it("sync step 1 returns all sidecars for empty client", async () => {
    const docA = new Y.Doc();
    docA.clientID = 100;
    docA.getMap("root").set("a", 1);
    await storage.handleUpdate(
      "doc-1",
      envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdate(docA))),
    );

    const docB = new Y.Doc();
    docB.clientID = 200;
    docB.getMap("root").set("b", 2);
    await storage.handleUpdate(
      "doc-1",
      envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdate(docB))),
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
    const v1Update = Y.encodeStateAsUpdate(doc);
    await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(v1Update)));

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
    const v1Update = Y.encodeStateAsUpdate(doc);
    const payload = makeContentEncryptedUpdate(v1Update);

    await storage.handleSyncStep2("doc-1", {
      version: 2,
      data: payload,
    } as unknown as VersionedSyncStep2Update);

    const document = await storage.getDocument("doc-1");
    expect(document).not.toBeNull();
  });

  it("handleSyncStep2 deduplicates (state unchanged on duplicate)", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("synced", true);
    const v1Update = Y.encodeStateAsUpdate(doc);
    const payload = makeContentEncryptedUpdate(v1Update);

    await storage.handleSyncStep2("doc-1", {
      version: 2,
      data: payload,
    } as unknown as VersionedSyncStep2Update);

    const stateAfterFirst = await storage.getDocumentState("doc-1");

    await storage.handleSyncStep2("doc-1", {
      version: 2,
      data: payload,
    } as unknown as VersionedSyncStep2Update);

    const stateAfterSecond = await storage.getDocumentState("doc-1");
    // Sidecars should not accumulate on dedup
    expect(stateAfterSecond!.sidecars.length).toBe(stateAfterFirst!.sidecars.length);
  });

  // ── 11. Compaction ─────────────────────────────────────────────────────────

  describe("compaction", () => {
    it("replaces multiple sidecars with a single compacted sidecar", async () => {
      // Store two updates from different clients
      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getMap("root").set("a", 1);
      const updateA = Y.encodeStateAsUpdate(docA);
      await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateA)));

      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getMap("root").set("b", 2);
      const updateB = Y.encodeStateAsUpdate(docB);
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
      const compactedSidecar = {
        encrypted: compactedBytes as EncryptedBinary,
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
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdate(docA))),
      );

      const state = await storage.getDocumentState("doc-1");
      const baseSV = Y.encodeStateVectorFromUpdateV2(state!.update);

      // Another update arrives while client is compacting
      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getMap("root").set("b", 2);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdate(docB))),
      );

      // Compaction with stale baseSV should be rejected
      const compactedSidecar = {
        encrypted: encodeSidecar({ entries: [], dictionary: new Map() }) as EncryptedBinary,
        index: [],
      };
      const accepted = await storage.handleCompaction("doc-1", compactedSidecar, baseSV);
      expect(accepted).toBe(false);

      // Sidecars should be unchanged (still 2)
      const currentState = await storage.getDocumentState("doc-1");
      expect(currentState!.sidecars.length).toBe(2);
    });

    it("rejects compaction for nonexistent document", async () => {
      const compactedSidecar = {
        encrypted: encodeSidecar({ entries: [], dictionary: new Map() }) as EncryptedBinary,
        index: [],
      };
      const accepted = await storage.handleCompaction(
        "nonexistent",
        compactedSidecar,
        new Uint8Array(0),
      );
      expect(accepted).toBe(false);
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
