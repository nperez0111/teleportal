import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createStorage, type Storage } from "unstorage";
import type { StateVector, Update, VersionedUpdate } from "teleportal";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import type { EncodedContentMap } from "../types";
import { MemoryDocumentStorage } from "../in-memory/document-storage";
import { UnstorageDocumentStorage } from "../unstorage/document-storage";
import { TieredDocumentStorage } from "./document-storage";

// ── Helpers ──────────────────────────────────────────────────────────────────

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: bytes,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

function makeUpdate(text: string): { v2: Uint8Array; versioned: VersionedUpdate } {
  const doc = new Y.Doc();
  doc.getText("text").insert(0, text);
  const v2 = Y.encodeStateAsUpdateV2(doc);
  return { v2, versioned: versionedUpdate(v2) };
}

function docFromStorageUpdate(update: Uint8Array): Y.Doc {
  const { structureUpdate } = decodeContentEncryptedPayload(update as EncryptedUpdatePayload);
  const doc = new Y.Doc();
  if (structureUpdate.length > 0) Y.applyUpdateV2(doc, structureUpdate);
  return doc;
}

// ── Test setup ───────────────────────────────────────────────────────────────

describe("TieredDocumentStorage", () => {
  let fast: MemoryDocumentStorage;
  let slow: MemoryDocumentStorage;
  let tiered: TieredDocumentStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.attributionMaps.clear();

    // Use separate backing maps so we can inspect each tier independently
    const fastDocs = new Map<string, any>();
    const slowDocs = new Map<string, any>();

    fast = new MemoryDocumentStorage(false, {
      write: async (key, doc) => { fastDocs.set(key, doc); },
      fetch: async (key) => fastDocs.get(key),
      delete: async (key) => { fastDocs.delete(key); },
    });
    slow = new MemoryDocumentStorage(false, {
      write: async (key, doc) => { slowDocs.set(key, doc); },
      fetch: async (key) => slowDocs.get(key),
      delete: async (key) => { slowDocs.delete(key); },
    });

    tiered = new TieredDocumentStorage(fast, slow, {
      persistIntervalMs: 60_000, // long interval — we flush manually in tests
      maxDirtyAgeMs: 60_000,
    });
  });

  afterEach(async () => {
    await tiered[Symbol.asyncDispose]();
  });

  // ── Basic round-trip ─────────────────────────────────────────────────────

  it("round-trips a document through handleUpdate / getDocument", async () => {
    const { versioned } = makeUpdate("hello");
    await tiered.handleUpdate("doc1", versioned);

    const doc = await tiered.getDocument("doc1");
    expect(doc).not.toBeNull();
    const yDoc = docFromStorageUpdate(doc!.content.update);
    expect(yDoc.getText("text").toString()).toBe("hello");
  });

  it("merges multiple updates", async () => {
    const { versioned: u1 } = makeUpdate("hello ");
    await tiered.handleUpdate("doc1", u1);

    const doc2 = new Y.Doc();
    const existing = await tiered.getDocument("doc1");
    const { structureUpdate } = decodeContentEncryptedPayload(
      existing!.content.update as EncryptedUpdatePayload,
    );
    Y.applyUpdateV2(doc2, structureUpdate);
    doc2.getText("text").insert(6, "world");
    const u2 = versionedUpdate(Y.encodeStateAsUpdateV2(doc2));
    await tiered.handleUpdate("doc1", u2);

    const result = await tiered.getDocument("doc1");
    const yDoc = docFromStorageUpdate(result!.content.update);
    expect(yDoc.getText("text").toString()).toBe("hello world");
  });

  // ── Load from slow tier ──────────────────────────────────────────────────

  it("loads a document from slow tier on first access", async () => {
    // Pre-populate slow tier directly
    const { versioned } = makeUpdate("from-slow");
    await slow.handleUpdate("doc1", versioned);

    // Verify fast tier is empty
    expect(await fast.getDocumentState("doc1")).toBeNull();

    // Read through tiered — should load from slow
    const doc = await tiered.getDocument("doc1");
    expect(doc).not.toBeNull();
    const yDoc = docFromStorageUpdate(doc!.content.update);
    expect(yDoc.getText("text").toString()).toBe("from-slow");

    // Fast tier should now have the document
    expect(await fast.getDocumentState("doc1")).not.toBeNull();
  });

  it("uses fast tier for subsequent reads after loading", async () => {
    const { versioned } = makeUpdate("initial");
    await slow.handleUpdate("doc1", versioned);

    // First read loads from slow
    await tiered.getDocument("doc1");

    // Modify slow tier directly (simulating external change)
    const { versioned: v2 } = makeUpdate("changed-in-slow");
    await slow.handleUpdate("doc1", v2);

    // Second read should still return fast tier data (not re-loaded)
    const doc = await tiered.getDocument("doc1");
    const yDoc = docFromStorageUpdate(doc!.content.update);
    expect(yDoc.getText("text").toString()).toBe("initial");
  });

  // ── Dirty tracking + persist ─────────────────────────────────────────────

  it("marks documents dirty on write and persists on flush", async () => {
    const { versioned } = makeUpdate("dirty-doc");
    await tiered.handleUpdate("doc1", versioned);

    // Slow tier should be empty (not persisted yet)
    expect(await slow.getDocumentState("doc1")).toBeNull();

    // Flush
    await tiered.flush("doc1");

    // Now slow tier should have the document
    const slowState = await slow.getDocumentState("doc1");
    expect(slowState).not.toBeNull();
  });

  it("flushAll persists all dirty documents", async () => {
    const { versioned: u1 } = makeUpdate("doc-a");
    const { versioned: u2 } = makeUpdate("doc-b");
    await tiered.handleUpdate("doc-a", u1);
    await tiered.handleUpdate("doc-b", u2);

    expect(await slow.getDocumentState("doc-a")).toBeNull();
    expect(await slow.getDocumentState("doc-b")).toBeNull();

    await tiered.flushAll();

    expect(await slow.getDocumentState("doc-a")).not.toBeNull();
    expect(await slow.getDocumentState("doc-b")).not.toBeNull();
  });

  it("flush is a no-op for clean documents", async () => {
    const { versioned } = makeUpdate("clean");
    await slow.handleUpdate("doc1", versioned);
    await tiered.getDocument("doc1"); // load into fast

    // Not dirty — flush should do nothing
    await tiered.flush("doc1");
    // Should not throw
  });

  // ── New document ─────────────────────────────────────────────────────────

  it("handles a new document that does not exist in either tier", async () => {
    const { versioned } = makeUpdate("brand-new");
    await tiered.handleUpdate("new-doc", versioned);

    const doc = await tiered.getDocument("new-doc");
    expect(doc).not.toBeNull();
    const yDoc = docFromStorageUpdate(doc!.content.update);
    expect(yDoc.getText("text").toString()).toBe("brand-new");

    // Not in slow yet
    expect(await slow.getDocumentState("new-doc")).toBeNull();

    // After flush, in slow
    await tiered.flush("new-doc");
    expect(await slow.getDocumentState("new-doc")).not.toBeNull();
  });

  // ── Delete ───────────────────────────────────────────────────────────────

  it("deletes from both tiers", async () => {
    const { versioned } = makeUpdate("to-delete");
    await tiered.handleUpdate("doc1", versioned);
    await tiered.flush("doc1");

    // Exists in both tiers
    expect(await fast.getDocumentState("doc1")).not.toBeNull();
    expect(await slow.getDocumentState("doc1")).not.toBeNull();

    await tiered.deleteDocument("doc1");

    expect(await fast.getDocumentState("doc1")).toBeNull();
    expect(await slow.getDocumentState("doc1")).toBeNull();
  });

  it("delete works for a document only in fast tier", async () => {
    const { versioned } = makeUpdate("fast-only");
    await tiered.handleUpdate("doc1", versioned);

    await tiered.deleteDocument("doc1");

    expect(await fast.getDocumentState("doc1")).toBeNull();
    expect(await tiered.getDocument("doc1")).toBeNull();
  });

  // ── Eviction ─────────────────────────────────────────────────────────────

  it("evicts clean documents from fast tier after inactivity", async () => {
    await tiered[Symbol.asyncDispose]();

    tiered = new TieredDocumentStorage(fast, slow, {
      persistIntervalMs: 1,
      maxDirtyAgeMs: 0,
      evictAfterMs: 1,
    });

    const { versioned } = makeUpdate("evictable");
    await tiered.handleUpdate("doc1", versioned);

    // Wait for persist + eviction sweep
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Document should be evicted from fast but still in slow
    expect(await fast.getDocumentState("doc1")).toBeNull();
    expect(await slow.getDocumentState("doc1")).not.toBeNull();

    // Re-access should reload from slow
    const doc = await tiered.getDocument("doc1");
    expect(doc).not.toBeNull();
    const yDoc = docFromStorageUpdate(doc!.content.update);
    expect(yDoc.getText("text").toString()).toBe("evictable");
  });

  // ── Concurrent load dedup ────────────────────────────────────────────────

  it("deduplicates concurrent loads of the same document", async () => {
    const { versioned } = makeUpdate("concurrent");
    await slow.handleUpdate("doc1", versioned);

    // Install mock AFTER populating slow tier (handleUpdate internally
    // calls getDocumentState, which would otherwise skew the count).
    let loadCount = 0;
    const originalGetState = slow.getDocumentState.bind(slow);
    slow.getDocumentState = async (key: string) => {
      loadCount++;
      return originalGetState(key);
    };

    // Trigger two concurrent reads
    const [doc1, doc2] = await Promise.all([
      tiered.getDocument("doc1"),
      tiered.getDocument("doc1"),
    ]);

    expect(doc1).not.toBeNull();
    expect(doc2).not.toBeNull();
    // #loadFromSlow calls slow.getDocumentState once. The dedup ensures
    // the second concurrent getDocument reuses the same load promise.
    expect(loadCount).toBe(1);
  });

  // ── Persist error handling ───────────────────────────────────────────────

  it("calls onPersistError and leaves document dirty on persist failure", async () => {
    await tiered[Symbol.asyncDispose]();

    const errors: Array<{ documentId: string; error: unknown }> = [];
    tiered = new TieredDocumentStorage(fast, slow, {
      persistIntervalMs: 60_000,
      onPersistError: (documentId, error) => errors.push({ documentId, error }),
    });

    const { versioned } = makeUpdate("will-fail");
    await tiered.handleUpdate("doc1", versioned);

    // Make slow tier throw on write
    slow.replaceDocumentState = async () => {
      throw new Error("persist failed");
    };

    await tiered.flushAll();

    expect(errors).toHaveLength(1);
    expect(errors[0].documentId).toBe("doc1");

    // Document should still be in fast tier
    const doc = await tiered.getDocument("doc1");
    expect(doc).not.toBeNull();
  });

  // ── Metadata ─────────────────────────────────────────────────────────────

  it("loads metadata from slow tier and persists changes on flush", async () => {
    const { versioned } = makeUpdate("meta-test");
    await slow.handleUpdate("doc1", versioned);
    await slow.writeDocumentMetadata("doc1", {
      createdAt: 1000,
      updatedAt: 2000,
      encrypted: false,
      files: ["file-1"],
    });

    // Read through tiered
    const meta = await tiered.getDocumentMetadata("doc1");
    expect(meta.files).toEqual(["file-1"]);

    // Update metadata
    await tiered.writeDocumentMetadata("doc1", {
      ...meta,
      files: ["file-1", "file-2"],
    });

    // Not in slow yet
    const slowMeta = await slow.getDocumentMetadata("doc1");
    expect(slowMeta.files).toEqual(["file-1"]);

    // Flush
    await tiered.flush("doc1");
    const flushedMeta = await slow.getDocumentMetadata("doc1");
    expect(flushedMeta.files).toEqual(["file-1", "file-2"]);
  });

  // ── Attribution ──────────────────────────────────────────────────────────

  // ── Dispose ──────────────────────────────────────────────────────────────

  it("flushes all dirty documents on dispose", async () => {
    const { versioned: u1 } = makeUpdate("dispose-a");
    const { versioned: u2 } = makeUpdate("dispose-b");
    await tiered.handleUpdate("doc-a", u1);
    await tiered.handleUpdate("doc-b", u2);

    expect(await slow.getDocumentState("doc-a")).toBeNull();
    expect(await slow.getDocumentState("doc-b")).toBeNull();

    await tiered[Symbol.asyncDispose]();

    expect(await slow.getDocumentState("doc-a")).not.toBeNull();
    expect(await slow.getDocumentState("doc-b")).not.toBeNull();
  });

  // ── Sync protocol ────────────────────────────────────────────────────────

  it("handleSyncStep1 works through tiered storage", async () => {
    const { versioned } = makeUpdate("sync-test");
    await tiered.handleUpdate("doc1", versioned);

    const emptyStateVector = Y.encodeStateVector(new Y.Doc()) as StateVector;
    const doc = await tiered.handleSyncStep1("doc1", emptyStateVector);

    expect(doc).not.toBeNull();
    expect(doc.id).toBe("doc1");
    expect(doc.content.update).toBeDefined();
  });
});

// ── Integration with unstorage slow tier ─────────────────────────────────────

describe("TieredDocumentStorage (unstorage slow tier)", () => {
  const openStorages: Storage[] = [];

  afterEach(async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    await Promise.all(openStorages.splice(0).map((s) => s.dispose()));
  });

  it("round-trips through memory fast + unstorage slow", async () => {
    const store = createStorage();
    openStorages.push(store);

    const fast = new MemoryDocumentStorage(false);
    const slow = new UnstorageDocumentStorage(store, { encrypted: false });
    const tiered = new TieredDocumentStorage(fast, slow, {
      persistIntervalMs: 60_000,
    });

    const { versioned } = makeUpdate("unstorage-test");
    await tiered.handleUpdate("doc1", versioned);
    await tiered.flush("doc1");

    // Verify slow tier has the data via a fresh read
    const slowDoc = await slow.getDocument("doc1");
    expect(slowDoc).not.toBeNull();
    const yDoc = docFromStorageUpdate(slowDoc!.content.update);
    expect(yDoc.getText("text").toString()).toBe("unstorage-test");

    await tiered[Symbol.asyncDispose]();
  });

  it("stores attribution in fast tier and forwards to slow on flush", async () => {
    const store = createStorage();
    openStorages.push(store);

    const fast = new MemoryDocumentStorage(false);
    const slow = new UnstorageDocumentStorage(store, { encrypted: false });
    const tiered = new TieredDocumentStorage(fast, slow, {
      persistIntervalMs: 60_000,
    });

    const { versioned } = makeUpdate("attr-test");
    const attribution = new Uint8Array([1, 2, 3]) as EncodedContentMap;

    await tiered.handleUpdate("doc1", versioned, attribution);

    // Attribution should be in fast tier
    const fastAttr = await fast.retrieveAttribution("doc1");
    expect(fastAttr).not.toBeNull();

    // Not in slow yet (unstorage has separate storage)
    const slowAttr = await slow.retrieveAttribution("doc1");
    expect(slowAttr).toBeNull();

    // Flush
    await tiered.flush("doc1");

    // Now in slow tier
    const flushedAttr = await slow.retrieveAttribution("doc1");
    expect(flushedAttr).not.toBeNull();

    await tiered[Symbol.asyncDispose]();
  });

  it("loads from unstorage slow tier into memory fast tier", async () => {
    const store = createStorage();
    openStorages.push(store);

    const slow = new UnstorageDocumentStorage(store, { encrypted: false });
    const { versioned } = makeUpdate("load-from-unstorage");
    await slow.handleUpdate("doc1", versioned);

    MemoryDocumentStorage.docs.clear();
    const fast = new MemoryDocumentStorage(false);
    const tiered = new TieredDocumentStorage(fast, slow, {
      persistIntervalMs: 60_000,
    });

    const doc = await tiered.getDocument("doc1");
    expect(doc).not.toBeNull();
    const yDoc = docFromStorageUpdate(doc!.content.update);
    expect(yDoc.getText("text").toString()).toBe("load-from-unstorage");

    await tiered[Symbol.asyncDispose]();
  });
});
