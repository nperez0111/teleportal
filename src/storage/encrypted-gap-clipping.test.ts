import { describe, expect, it, beforeEach } from "bun:test";
import * as Y from "yjs";
import type { StateVector, Update, VersionedUpdate } from "teleportal";
import { getEmptyStateVector } from "teleportal";
import { generateEncryptionKey, type EncryptedBinary } from "teleportal/encryption-key";
import {
  decodeContentEncryptedPayload,
  decryptContentPayload,
  encodeContentEncryptedPayload,
  encryptUpdateContent,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { MemoryDocumentStorage } from "./in-memory/document-storage";

/**
 * Regression test: clipUpdateAtGaps on encrypted documents must NOT corrupt
 * the structure-sidecar alignment. When a lost update creates a gap, the
 * clipped structure update must still be decryptable with the filtered sidecars.
 */

const DOC = "encrypted-gap-test";
const SENDER = 111;

async function makeEncryptedUpdate(key: CryptoKey, v2Update: Uint8Array): Promise<VersionedUpdate> {
  const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, v2Update, 2);
  const payload = encodeContentEncryptedPayload({
    structureUpdate,
    encryptedSidecars: [encryptedSidecar],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

async function decryptPayload(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  const decoded = decodeContentEncryptedPayload(payload as EncryptedUpdatePayload);
  return decryptContentPayload(
    key,
    decoded.structureUpdate,
    decoded.encryptedSidecars as EncryptedBinary[],
    2,
  );
}

describe("encrypted documents with lost-update gaps", () => {
  let storage: MemoryDocumentStorage;
  let key: CryptoKey;

  beforeEach(async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    key = await generateEncryptionKey();
    storage = new MemoryDocumentStorage(true);
  });

  it("sync-step-1 with clipped gaps is still decryptable (text)", async () => {
    const doc = new Y.Doc();
    doc.clientID = SENDER;
    const text = doc.getText("content");
    const updates: Uint8Array[] = [];
    let prev = Y.encodeStateVector(doc);
    for (let i = 0; i < 10; i++) {
      text.insert(text.length, `char-${i}`);
      updates.push(Y.encodeStateAsUpdateV2(doc, prev));
      prev = Y.encodeStateVector(doc);
    }

    // Store all EXCEPT updates 3 and 5 (simulating lost updates)
    for (const i of [0, 1, 2, 4, 6, 7, 8, 9]) {
      await storage.handleUpdate(DOC, await makeEncryptedUpdate(key, updates[i]!));
    }

    const served = await storage.handleSyncStep1(DOC, getEmptyStateVector());
    const restored = await decryptPayload(key, served.content.update as Uint8Array);

    const receiver = new Y.Doc();
    if (restored.length > 0) Y.applyUpdateV2(receiver, restored);
    expect(receiver.store.pendingStructs).toBeNull();
  });

  it("sync-step-1 with clipped gaps is still decryptable (array/map)", async () => {
    const doc = new Y.Doc();
    doc.clientID = SENDER;
    const map = doc.getMap("root");
    const arr = doc.getArray("items");
    const updates: Uint8Array[] = [];
    let prev = Y.encodeStateVector(doc);
    for (let i = 0; i < 10; i++) {
      map.set(`key-${i}`, `value-${i}`);
      arr.push([{ id: i, name: `item-${i}` }]);
      updates.push(Y.encodeStateAsUpdateV2(doc, prev));
      prev = Y.encodeStateVector(doc);
    }

    for (const i of [0, 1, 2, 4, 6, 7, 8, 9]) {
      await storage.handleUpdate(DOC, await makeEncryptedUpdate(key, updates[i]!));
    }

    const served = await storage.handleSyncStep1(DOC, getEmptyStateVector());
    const restored = await decryptPayload(key, served.content.update as Uint8Array);

    const receiver = new Y.Doc();
    if (restored.length > 0) Y.applyUpdateV2(receiver, restored);
    expect(receiver.store.pendingStructs).toBeNull();
  });

  it("sync-step-1 with clipped gaps + partial sync is decryptable", async () => {
    const doc = new Y.Doc();
    doc.clientID = SENDER;
    const text = doc.getText("content");
    const updates: Uint8Array[] = [];
    let prev = Y.encodeStateVector(doc);
    for (let i = 0; i < 10; i++) {
      text.insert(text.length, String.fromCharCode(65 + i));
      updates.push(Y.encodeStateAsUpdateV2(doc, prev));
      prev = Y.encodeStateVector(doc);
    }

    for (const i of [0, 1, 2, 4, 6, 7, 8, 9]) {
      await storage.handleUpdate(DOC, await makeEncryptedUpdate(key, updates[i]!));
    }

    // Client already has clocks 0-1 (first 2 updates)
    const partialDoc = new Y.Doc();
    Y.applyUpdateV2(partialDoc, updates[0]!);
    Y.applyUpdateV2(partialDoc, updates[1]!);
    const partialSV = Y.encodeStateVector(partialDoc) as StateVector;

    const served = await storage.handleSyncStep1(DOC, partialSV);
    const restored = await decryptPayload(key, served.content.update as Uint8Array);

    Y.applyUpdateV2(partialDoc, restored);
    expect(partialDoc.store.pendingStructs).toBeNull();
  });

  it("multi-client encrypted doc with one client's updates gapped", async () => {
    const docA = new Y.Doc();
    docA.clientID = 100;
    const docB = new Y.Doc();
    docB.clientID = 200;

    // Client A: 5 updates
    const updatesA: Uint8Array[] = [];
    let prevA = Y.encodeStateVector(docA);
    for (let i = 0; i < 5; i++) {
      docA.getText("content").insert(docA.getText("content").length, `A${i}`);
      updatesA.push(Y.encodeStateAsUpdateV2(docA, prevA));
      prevA = Y.encodeStateVector(docA);
    }

    // Client B: 5 updates
    const updatesB: Uint8Array[] = [];
    let prevB = Y.encodeStateVector(docB);
    for (let i = 0; i < 5; i++) {
      docB.getMap("meta").set(`key-${i}`, i);
      updatesB.push(Y.encodeStateAsUpdateV2(docB, prevB));
      prevB = Y.encodeStateVector(docB);
    }

    // Store A's updates (skip index 2 — gap)
    for (const i of [0, 1, 3, 4]) {
      await storage.handleUpdate(DOC, await makeEncryptedUpdate(key, updatesA[i]!));
    }
    // Store all of B's updates
    for (const update of updatesB) {
      await storage.handleUpdate(DOC, await makeEncryptedUpdate(key, update));
    }

    const served = await storage.handleSyncStep1(DOC, getEmptyStateVector());
    const restored = await decryptPayload(key, served.content.update as Uint8Array);

    const receiver = new Y.Doc();
    if (restored.length > 0) Y.applyUpdateV2(receiver, restored);
    expect(receiver.store.pendingStructs).toBeNull();
    // Client B's data should be fully present
    expect(receiver.getMap("meta").get("key-4")).toBe(4);
  });
});
