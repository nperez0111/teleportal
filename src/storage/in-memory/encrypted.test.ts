import { beforeEach, describe, expect, it } from "bun:test";
import { EncryptedBinary } from "teleportal/encryption-key";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedSnapshot,
  encodeEncryptedUpdateMessages,
  getEmptyEncryptedStateVector,
} from "teleportal/protocol/encryption";
import type {
  DecodedEncryptedUpdatePayload,
  EncryptedSnapshot,
} from "teleportal/protocol/encryption";
import { EncryptedMemoryStorage } from "./encrypted";

describe("EncryptedMemoryStorage", () => {
  let storage: EncryptedMemoryStorage;

  beforeEach(() => {
    EncryptedMemoryStorage.docs.clear();
    storage = new EncryptedMemoryStorage();
  });

  it("returns default metadata for missing document", async () => {
    const metadata = await storage.getDocumentMetadata("doc-1");
    expect(metadata.encrypted).toBe(true);
    expect(metadata.activeSnapshotId).toBeUndefined();
  });

  it("stores and fetches snapshots", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([1, 2, 3]) as EncryptedBinary,
    };
    await storage.storeSnapshot("doc-1", snapshot, {
      id: snapshot.id,
      parentSnapshotId: snapshot.parentSnapshotId,
      createdAt: Date.now(),
      updateVersion: 0,
      clientCounters: {},
    });

    const fetched = await storage.fetchSnapshot("doc-1", snapshot.id);
    expect(fetched?.id).toBe(snapshot.id);
    expect(fetched?.payload).toEqual(snapshot.payload);
  });

  it("stores updates and assigns server versions", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );

    const updatePayload: DecodedEncryptedUpdatePayload = {
      id: "update-1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([5, 6]) as EncryptedBinary,
    };
    const storedPayload = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([updatePayload]),
    );

    expect(storedPayload).toBeDefined();
    const decoded = decodeEncryptedUpdate(storedPayload!);
    expect(decoded.type).toBe("update");
    expect(decoded.updates[0].serverVersion).toBe(1);
  });

  it("returns snapshot + updates on sync step 1 when client is empty", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );

    const updatePayload: DecodedEncryptedUpdatePayload = {
      id: "update-1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([5, 6]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([updatePayload]),
    );

    const result = await storage.handleSyncStep1(
      "doc-1",
      getEmptyEncryptedStateVector(),
    );
    const decoded = decodeFromSyncStep2(result.content.update);
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);
  });

  it("builds document with snapshot and updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );

    const updatePayload: DecodedEncryptedUpdatePayload = {
      id: "update-1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([5, 6]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([updatePayload]),
    );

    const doc = await storage.getDocument("doc-1");
    expect(doc).not.toBeNull();
    const decoded = decodeFromSyncStep2(doc!.content.update);
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);

    const state = decodeFromStateVector(doc!.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(1);
  });
});
