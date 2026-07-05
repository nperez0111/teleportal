import { describe, expect, it, beforeEach } from "bun:test";
import * as Y from "yjs";
import type { Update, VersionedUpdate } from "teleportal";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { MemoryDocumentStorage } from "./in-memory/document-storage";
import { MergeOnWriteStorage } from "./merge-on-write-storage";

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: bytes,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

describe("MergeOnWriteStorage", () => {
  let storage: MergeOnWriteStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    storage = new MergeOnWriteStorage(new MemoryDocumentStorage(false));
  });

  it("keeps pending log empty after writes", async () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello");
    await storage.handleUpdate("doc1", versionedUpdate(Y.encodeStateAsUpdateV2(doc)));

    const { updates } = await storage.getPendingUpdates("doc1");
    expect(updates).toHaveLength(0);
  });

  it("base state reflects all writes immediately", async () => {
    const doc1 = new Y.Doc();
    doc1.getText("t").insert(0, "hello");
    await storage.handleUpdate("doc1", versionedUpdate(Y.encodeStateAsUpdateV2(doc1)));

    const doc2 = new Y.Doc();
    Y.applyUpdateV2(doc2, Y.encodeStateAsUpdateV2(doc1));
    doc2.getText("t").insert(5, " world");
    await storage.handleUpdate("doc1", versionedUpdate(Y.encodeStateAsUpdateV2(doc2)));

    const base = await storage.getBaseState("doc1");
    expect(base).not.toBeNull();

    const verify = new Y.Doc();
    Y.applyUpdateV2(verify, base!.update);
    expect(verify.getText("t").toString()).toBe("hello world");
  });

  it("getDocument returns merged state", async () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "test");
    await storage.handleUpdate("doc1", versionedUpdate(Y.encodeStateAsUpdateV2(doc)));

    const result = await storage.getDocument("doc1");
    expect(result).not.toBeNull();

    const decoded = decodeContentEncryptedPayload(
      result!.content.update as unknown as EncryptedUpdatePayload,
    );
    const verify = new Y.Doc();
    Y.applyUpdateV2(verify, decoded.structureUpdate);
    expect(verify.getText("t").toString()).toBe("test");
  });

  it("tracks sizeBytes in metadata", async () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello");
    await storage.handleUpdate("doc1", versionedUpdate(Y.encodeStateAsUpdateV2(doc)));

    const meta = await storage.getDocumentMetadata("doc1");
    expect(meta.sizeBytes).toBeGreaterThan(0);
  });
});
