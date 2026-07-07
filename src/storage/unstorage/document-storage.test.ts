import { beforeEach, describe, expect, it } from "bun:test";
import { createStorage } from "unstorage";
import * as Y from "yjs";
import { EncryptedBinary } from "teleportal/encryption-key";
import type {
  StateVector,
  Update,
  VersionedUpdate,
  VersionedSyncStep2Update,
  SyncStep2UpdateV2,
} from "teleportal";
import { getEmptyStateVector } from "../../lib/protocol/utils";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  stripContent,
  encodeSidecar,
  decodeSidecar,
  mergeSidecars,
  hashSidecar,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  createContentAttribute,
  createContentIds,
  createContentIdsFromUpdate,
  createContentMapFromContentIds,
  decodeContentMap,
  encodeContentMap,
  IdSet,
} from "teleportal/attribution";
import type { EncodedContentMap } from "../types";
import { UnstorageDocumentStorage } from "./document-storage";

// ── Shared helpers ──────────────────────────────────────────────────────────

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: bytes,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

/** Decode a content-encrypted payload to get the structure update (V2). */
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

/**
 * Wrap an already-encoded content-encrypted payload into a VersionedUpdate.
 * Use this for encrypted tests where makeContentEncryptedUpdate() already produces
 * the envelope payload and it should NOT be re-encoded by versionedUpdate().
 */
function envelopeUpdate(payload: Uint8Array): VersionedUpdate {
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

/**
 * Build a content-encrypted update payload from a Y.js V2 update.
 *
 * Strips content from the update into a sidecar (treated as an opaque
 * encrypted blob in tests) and encodes the result as a
 * ContentEncryptedPayload.
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
 * Create a Y.js document with some text content so we get a real V2 update
 * with CRDT metadata + content.
 */
function makeYjsUpdate(text: string, clientID?: number): Uint8Array {
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  doc.getText("content").insert(0, text);
  return Y.encodeStateAsUpdateV2(doc);
}

// ── Unencrypted ─────────────────────────────────────────────────────────────

describe("UnstorageDocumentStorage (unencrypted)", () => {
  let storage: UnstorageDocumentStorage;

  beforeEach(() => {
    storage = new UnstorageDocumentStorage(createStorage(), { encrypted: false });
  });

  describe("handleUpdate", () => {
    it("should create and store update with unique key", async () => {
      const key = "test-doc-1";
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "Hello, World!");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const newDoc = docFromUpdate(retrieved!.content.update);
      expect(newDoc.getText("content").toString()).toBe("Hello, World!");
    });

    it("should apply multiple updates to existing document", async () => {
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
      const newDoc = docFromUpdate(retrieved!.content.update);
      expect(newDoc.getText("content").toString()).toBe("Hello, World!");
    });

    it("should update metadata updatedAt timestamp", async () => {
      const key = "test-doc-3";
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "test");
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
      const key = "test-doc-5";
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

    it("should merge multiple updates into one on retrieval", async () => {
      const key = "test-doc-6";
      const doc1 = new Y.Doc();
      const text1 = doc1.getText("content");
      text1.insert(0, "First");
      const update1 = Y.encodeStateAsUpdateV2(doc1) as Update;

      await storage.handleUpdate(key, versionedUpdate(update1));

      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      const text2 = doc2.getText("content");
      text2.insert(5, " Second");
      const update2 = Y.encodeStateAsUpdateV2(doc2) as Update;

      await storage.handleUpdate(key, versionedUpdate(update2));

      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const newDoc = docFromUpdate(retrieved!.content.update);
      expect(newDoc.getText("content").toString()).toBe("First Second");
    });

    it("getDocument returns full state after multiple updates", async () => {
      const key = "test-doc-full-state";

      // First update
      const doc1 = new Y.Doc();
      doc1.getText("content").insert(0, "Alpha");
      const update1 = Y.encodeStateAsUpdateV2(doc1) as Update;
      await storage.handleUpdate(key, versionedUpdate(update1));

      // Second update building on the first
      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, update1);
      doc2.getText("content").insert(5, " Beta");
      const update2 = Y.encodeStateAsUpdateV2(doc2) as Update;
      await storage.handleUpdate(key, versionedUpdate(update2));

      // getDocument should return a document containing both updates
      const retrieved = await storage.getDocument(key);
      expect(retrieved).not.toBeNull();
      const fullDoc = docFromUpdate(retrieved!.content.update);
      expect(fullDoc.getText("content").toString()).toBe("Alpha Beta");
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
      // Manually set invalid metadata
      const unstorage = createStorage();
      await unstorage.setItem(key + ":meta", {
        createdAt: "invalid",
        updatedAt: "invalid",
        encrypted: "invalid",
      });

      const testStorage = new UnstorageDocumentStorage(unstorage, { encrypted: false });
      const metadata = await testStorage.getDocumentMetadata(key);

      expect(typeof metadata.createdAt).toBe("number");
      expect(metadata.createdAt).toBeGreaterThan(0);
      expect(typeof metadata.updatedAt).toBe("number");
      expect(metadata.updatedAt).toBeGreaterThan(0);
      expect(typeof metadata.encrypted).toBe("boolean");
      expect(metadata.encrypted).toBe(false);
    });
  });

  describe("deleteDocument", () => {
    it("should delete document and all updates", async () => {
      const key = "test-doc-10";
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "test");
      const update = Y.encodeStateAsUpdateV2(doc) as Update;

      await storage.handleUpdate(key, versionedUpdate(update));
      await storage.writeDocumentMetadata(key, {
        createdAt: 1000,
        updatedAt: 2000,
        encrypted: false,
      });

      expect(await storage.getDocument(key)).not.toBeNull();

      await storage.deleteDocument(key);

      expect(await storage.getDocument(key)).toBeNull();
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

    it("should handle concurrent transactions with locking", async () => {
      const key = "test-doc-18";
      const executionOrder: string[] = [];

      // Start first transaction
      const promise1 = storage.transaction(key, async () => {
        executionOrder.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 1));
        executionOrder.push("end-1");
        return "result-1";
      });

      // Start second transaction immediately (should wait for first)
      const promise2 = storage.transaction(key, async () => {
        executionOrder.push("start-2");
        await new Promise((resolve) => setTimeout(resolve, 1));
        executionOrder.push("end-2");
        return "result-2";
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe("result-1");
      expect(result2).toBe("result-2");
      // Verify transactions executed (locking may cause reordering, but both should complete)
      expect(executionOrder).toContain("start-1");
      expect(executionOrder).toContain("end-1");
      expect(executionOrder).toContain("start-2");
      expect(executionOrder).toContain("end-2");
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
      doc.getText("content").insert(0, "test");
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

describe("UnstorageDocumentStorage (encrypted)", () => {
  let storage: UnstorageDocumentStorage;

  beforeEach(() => {
    storage = new UnstorageDocumentStorage(createStorage(), { encrypted: true });
  });

  // ── Metadata ───────────────────────────────────────────────────────────────

  it("returns default metadata for a missing document", async () => {
    const metadata = await storage.getDocumentMetadata("doc-1");
    expect(metadata.encrypted).toBe(true);
    expect(typeof metadata.createdAt).toBe("number");
    expect(typeof metadata.updatedAt).toBe("number");
  });

  // ── Store & retrieve state ─────────────────────────────────────────────────

  it("stores a content-encrypted update and retrieves state", async () => {
    const v1 = makeYjsUpdate("hello");
    const payload = makeContentEncryptedUpdate(v1);

    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    const state = await storage.getDocumentState("doc-1");
    expect(state).not.toBeNull();
    // Internally stored as V2; verify it has content
    expect(state!.update.length).toBeGreaterThan(0);
    expect(state!.sidecars.length).toBe(1);
  });

  it("merges multiple updates into consolidated state", async () => {
    const update1 = makeContentEncryptedUpdate(makeYjsUpdate("hello", 1));
    const update2 = makeContentEncryptedUpdate(makeYjsUpdate("world", 2));

    await storage.handleUpdate("doc-1", envelopeUpdate(update1));
    await storage.handleUpdate("doc-1", envelopeUpdate(update2));

    const state = await storage.getDocumentState("doc-1");
    expect(state).not.toBeNull();
    // Sidecars accumulate (one per update)
    expect(state!.sidecars.length).toBe(2);

    // The merged structure update is V2 internally
    const sv = Y.encodeStateVectorFromUpdateV2(state!.update);
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, state!.update);
    // Both clients contributed, so the state vector covers both
    expect(Y.decodeStateVector(sv).size).toBe(2);
  });

  // ── Sync step 1 ────────────────────────────────────────────────────────────

  describe("handleSyncStep1", () => {
    it("returns empty payload when no document exists", async () => {
      const result = await storage.handleSyncStep1("doc-1", getEmptyStateVector());
      const decoded = decodeContentEncryptedPayload(
        result.content.update as unknown as EncryptedUpdatePayload,
      );
      expect(decoded.structureUpdate.length).toBe(0);
      expect(decoded.encryptedSidecars.length).toBe(0);
    });

    it("returns full state for an empty client state vector", async () => {
      const v1 = makeYjsUpdate("hello");
      const payload = makeContentEncryptedUpdate(v1);
      await storage.handleUpdate("doc-1", envelopeUpdate(payload));

      const result = await storage.handleSyncStep1("doc-1", getEmptyStateVector());
      const decoded = decodeContentEncryptedPayload(
        result.content.update as unknown as EncryptedUpdatePayload,
      );
      expect(decoded.structureUpdate.length).toBeGreaterThan(0);
      expect(decoded.encryptedSidecars.length).toBe(1);
    });

    it("returns empty diff when client is already up-to-date", async () => {
      const v1 = makeYjsUpdate("hello");
      const payload = makeContentEncryptedUpdate(v1);
      await storage.handleUpdate("doc-1", envelopeUpdate(payload));

      // Get the server's state vector from the V2 update
      const state = await storage.getDocumentState("doc-1");
      const serverSV = Y.encodeStateVectorFromUpdateV2(state!.update) as StateVector;

      const result = await storage.handleSyncStep1("doc-1", serverSV);
      const decoded = decodeContentEncryptedPayload(
        result.content.update as unknown as EncryptedUpdatePayload,
      );
      // Diff of identical state vectors produces a minimal (empty structs) update
      const diffDoc = new Y.Doc();
      Y.applyUpdateV2(diffDoc, decoded.structureUpdate);
      expect(diffDoc.getText("content").toString()).toBe("");
    });

    it("returns only the diff for a partially synced client", async () => {
      // First update from client 1
      const doc1 = new Y.Doc();
      doc1.clientID = 1;
      doc1.getText("content").insert(0, "hello");
      const update1 = Y.encodeStateAsUpdateV2(doc1);
      const sv1 = Y.encodeStateVector(doc1) as StateVector;

      await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update1)));

      // Second update from client 2
      const doc2 = new Y.Doc();
      doc2.clientID = 2;
      doc2.getText("content").insert(0, "world");
      const update2 = Y.encodeStateAsUpdateV2(doc2);

      await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(update2)));

      // Client knows about client 1 but not client 2
      const result = await storage.handleSyncStep1("doc-1", sv1);
      const decoded = decodeContentEncryptedPayload(
        result.content.update as unknown as EncryptedUpdatePayload,
      );

      // The diff should only contain client 2's changes
      const diffDoc = new Y.Doc();
      Y.applyUpdateV2(diffDoc, decoded.structureUpdate);
      // Apply to a doc that already has client 1's data
      const fullDoc = new Y.Doc();
      Y.applyUpdateV2(fullDoc, update1);
      Y.applyUpdateV2(fullDoc, decoded.structureUpdate);
      // The full doc should have both contributions
      expect(fullDoc.getText("content").toString().length).toBeGreaterThan(0);
    });
  });

  // ── Sidecar filtering ──────────────────────────────────────────────────────

  describe("sidecar filtering on sync", () => {
    it("filters sidecars to only those needed for a partial sync", async () => {
      const docA = new Y.Doc();
      docA.clientID = 100;
      docA.getText("content").insert(0, "hello");
      const updateA = Y.encodeStateAsUpdateV2(docA);
      await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateA)));

      const docB = new Y.Doc();
      docB.clientID = 200;
      docB.getText("content").insert(0, "world");
      const updateB = Y.encodeStateAsUpdateV2(docB);
      await storage.handleUpdate("doc-1", envelopeUpdate(makeContentEncryptedUpdate(updateB)));

      // Client knows A but not B
      const svA = Y.encodeStateVector(docA) as StateVector;
      const result = await storage.handleSyncStep1("doc-1", svA);
      const decoded = decodeContentEncryptedPayload(
        result.content.update as unknown as EncryptedUpdatePayload,
      );

      // Only B's sidecar should be returned
      expect(decoded.encryptedSidecars.length).toBe(1);
    });

    it("returns all sidecars for empty client state vector", async () => {
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("hello", 1))),
      );
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("world", 2))),
      );

      const result = await storage.handleSyncStep1("doc-1", getEmptyStateVector());
      const decoded = decodeContentEncryptedPayload(
        result.content.update as unknown as EncryptedUpdatePayload,
      );

      expect(decoded.encryptedSidecars.length).toBe(2);
    });

    it("returns no sidecars for up-to-date client", async () => {
      const doc = new Y.Doc();
      doc.getText("content").insert(0, "hello");
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(Y.encodeStateAsUpdateV2(doc))),
      );

      const serverSV = Y.encodeStateVector(doc) as StateVector;
      const result = await storage.handleSyncStep1("doc-1", serverSV);
      const decoded = decodeContentEncryptedPayload(
        result.content.update as unknown as EncryptedUpdatePayload,
      );

      expect(decoded.encryptedSidecars.length).toBe(0);
    });
  });

  // ── Dedup ──────────────────────────────────────────────────────────────────

  it("identical re-applied updates are CRDT-idempotent (state vector unchanged)", async () => {
    const v1 = makeYjsUpdate("hello");
    const payload = makeContentEncryptedUpdate(v1);

    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    // Get state after first write
    const stateAfterFirst = await storage.getDocumentState("doc-1");
    expect(stateAfterFirst).not.toBeNull();
    const svAfterFirst = Y.encodeStateVectorFromUpdateV2(stateAfterFirst!.update);

    // Sending the exact same update again -- merge is idempotent so the SV
    // does not advance; sidecars may accumulate (compaction handles cleanup).
    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    const stateAfterDup = await storage.getDocumentState("doc-1");
    const svAfterDup = Y.encodeStateVectorFromUpdateV2(stateAfterDup!.update);
    expect(new Uint8Array(svAfterDup)).toEqual(new Uint8Array(svAfterFirst));
  });

  it("accepts a new update after a duplicate", async () => {
    const v1 = makeYjsUpdate("hello", 1);
    const payload = makeContentEncryptedUpdate(v1);

    await storage.handleUpdate("doc-1", envelopeUpdate(payload));
    // Duplicate -- CRDT-idempotent
    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    // Genuinely new update from a different client
    const v2 = makeYjsUpdate("world", 2);
    const payload2 = makeContentEncryptedUpdate(v2);
    await storage.handleUpdate("doc-1", envelopeUpdate(payload2));

    const state = await storage.getDocumentState("doc-1");
    // At least the two distinct clients' sidecars are present. The duplicate
    // write also appends a sidecar; compaction is what collapses redundancy.
    expect(state!.sidecars.length).toBeGreaterThanOrEqual(2);
    // State vector reflects both clients.
    const sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdateV2(state!.update));
    expect(sv.size).toBe(2);
  });

  // ── getDocument ────────────────────────────────────────────────────────────

  it("returns null for a document that does not exist", async () => {
    const doc = await storage.getDocument("nonexistent");
    expect(doc).toBeNull();
  });

  it("returns full document with encoded payload and state vector", async () => {
    const v1 = makeYjsUpdate("hello");
    const payload = makeContentEncryptedUpdate(v1);
    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    const doc = await storage.getDocument("doc-1");
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe("doc-1");
    expect(doc!.metadata.encrypted).toBe(true);

    // Decode the update payload
    const decoded = decodeContentEncryptedPayload(
      doc!.content.update as unknown as EncryptedUpdatePayload,
    );
    expect(decoded.structureUpdate.length).toBeGreaterThan(0);
    expect(decoded.encryptedSidecars.length).toBe(1);

    // State vector should be non-empty
    const sv = Y.decodeStateVector(doc!.content.stateVector);
    expect(sv.size).toBeGreaterThan(0);
  });

  // ── Attribution ────────────────────────────────────────────────────────────

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
      const v1 = makeYjsUpdate("hello");
      const payload = makeContentEncryptedUpdate(v1);
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
      const v1 = makeYjsUpdate("hello");
      const payload = makeContentEncryptedUpdate(v1);

      await storage.handleUpdate("doc-1", envelopeUpdate(payload));

      const result = await storage.retrieveAttribution("doc-1");
      expect(result).toBeNull();
    });

    it("merges multiple attributions on retrieve", async () => {
      const v1a = makeYjsUpdate("hello", 10);
      const v1b = makeYjsUpdate("world", 20);
      const payloadA = makeContentEncryptedUpdate(v1a);
      const payloadB = makeContentEncryptedUpdate(v1b);

      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(payloadA),
        makeAttribution("user-1", 1, 0, 5),
      );
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(payloadB),
        makeAttribution("user-2", 2, 0, 3),
      );

      const retrieved = await storage.retrieveAttribution("doc-1");
      expect(retrieved).not.toBeNull();
      const map = decodeContentMap(retrieved!);
      expect(map.inserts.clients.size).toBe(2);
    });

    it("cleans up attribution on deleteDocument", async () => {
      const v1 = makeYjsUpdate("hello");
      const payload = makeContentEncryptedUpdate(v1);

      await storage.handleUpdate("doc-1", envelopeUpdate(payload), makeAttribution("user-1"));
      expect(await storage.retrieveAttribution("doc-1")).not.toBeNull();

      await storage.deleteDocument("doc-1");
      expect(await storage.retrieveAttribution("doc-1")).toBeNull();
    });
  });

  // ── Compaction ─────────────────────────────────────────────────────────────

  describe("compaction", () => {
    it("replaces multiple sidecars with a single compacted sidecar", async () => {
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("hello", 1))),
      );
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("world", 2))),
      );

      let state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(2);

      // State is V2 internally; use V2 state vector for baseSV
      const baseSV = Y.encodeStateVectorFromUpdateV2(state!.update);
      const { buildSidecarIndex } = await import("teleportal/protocol/encryption");

      const allDecoded = state!.sidecars.map((s) =>
        decodeSidecar(s.encrypted as unknown as Uint8Array),
      );
      const merged = mergeSidecars(allDecoded);
      const compactedEncrypted = encodeSidecar(merged) as EncryptedBinary;
      const compactedSidecar = {
        encrypted: compactedEncrypted,
        index: buildSidecarIndex(merged.entries),
        hash: await hashSidecar(compactedEncrypted),
      };

      const accepted = await storage.handleCompaction("doc-1", compactedSidecar, baseSV);
      expect(accepted).toBe(true);

      state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(1);
    });

    it("rejects compaction when state has changed", async () => {
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("hello", 1))),
      );

      const state = await storage.getDocumentState("doc-1");
      const baseSV = Y.encodeStateVectorFromUpdateV2(state!.update);

      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("world", 2))),
      );

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
      expect((await storage.getDocumentState("doc-1"))!.sidecars.length).toBe(2);
    });
  });

  // ── Inline compaction (compaction piggy-backed on update) ─────────────────

  describe("inline compaction via handleUpdate", () => {
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
      for (let i = 1; i <= 3; i++) {
        await storage.handleUpdate(
          "doc-1",
          envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate(`text-${i}`, i * 100))),
        );
      }

      let state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(3);

      const compaction = await buildCompaction(state!.sidecars);

      const newUpdate = makeYjsUpdate("new-text", 400);
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(newUpdate, compaction)),
      );

      state = await storage.getDocumentState("doc-1");
      expect(state!.sidecars.length).toBe(2);
      expect(state!.sidecars[0].hash).toEqual(compaction.hash);
    });

    it("keeps concurrent sidecars alongside compaction", async () => {
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("a", 100))),
      );
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("b", 200))),
      );

      let state = await storage.getDocumentState("doc-1");
      const compaction = await buildCompaction(state!.sidecars);

      // Concurrent write
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("c", 300))),
      );

      // Apply compaction — concurrent sidecar should be kept
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(makeYjsUpdate("d", 400), compaction)),
      );

      state = await storage.getDocumentState("doc-1");
      // 1 compacted + 1 concurrent + 1 new = 3
      expect(state!.sidecars.length).toBe(3);
      expect(state!.sidecars[0].hash).toEqual(compaction.hash);
    });

    it("skips compaction when source sidecars are missing", async () => {
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("a", 100))),
      );
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("b", 200))),
      );

      let state = await storage.getDocumentState("doc-1");
      const compaction = await buildCompaction(state!.sidecars);

      // Another client already compacted via handleCompaction
      const allDecoded = state!.sidecars.map((s) =>
        decodeSidecar(s.encrypted as unknown as Uint8Array),
      );
      const merged = mergeSidecars(allDecoded);
      const otherBytes = encodeSidecar(merged) as EncryptedBinary;
      await storage.handleCompaction(
        "doc-1",
        { encrypted: otherBytes, index: [], hash: await hashSidecar(otherBytes) },
        Y.encodeStateVectorFromUpdateV2(state!.update),
      );

      // Now our compaction has stale sourceHashes
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeCompactionPayload(makeYjsUpdate("c", 300), compaction)),
      );

      state = await storage.getDocumentState("doc-1");
      // Skipped: 1 (other compaction) + 1 (new) = 2
      expect(state!.sidecars.length).toBe(2);
    });

    it("hash survives serialization round-trip through unstorage", async () => {
      await storage.handleUpdate(
        "doc-1",
        envelopeUpdate(makeContentEncryptedUpdate(makeYjsUpdate("hello", 100))),
      );

      const state = await storage.getDocumentState("doc-1");
      const sidecar = state!.sidecars[0];

      expect(sidecar.hash).toBeInstanceOf(Uint8Array);
      expect(sidecar.hash.length).toBe(32);
      expect(sidecar.hash).toEqual(await hashSidecar(sidecar.encrypted));
    });
  });

  // ── Delete document ────────────────────────────────────────────────────────

  it("deleteDocument removes state, metadata, and attribution", async () => {
    const v1 = makeYjsUpdate("hello");
    const payload = makeContentEncryptedUpdate(v1);

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

    await storage.handleUpdate("doc-1", envelopeUpdate(payload), makeAttribution("user-1"));

    // Verify everything exists
    expect(await storage.getDocumentState("doc-1")).not.toBeNull();
    expect(await storage.getDocument("doc-1")).not.toBeNull();
    expect(await storage.retrieveAttribution("doc-1")).not.toBeNull();

    await storage.deleteDocument("doc-1");

    // All data should be gone
    expect(await storage.getDocumentState("doc-1")).toBeNull();
    expect(await storage.getDocument("doc-1")).toBeNull();
    expect(await storage.retrieveAttribution("doc-1")).toBeNull();
  });
});
