import { beforeEach, describe, expect, it } from "bun:test";
import { createStorage } from "unstorage";
import { EncryptedBinary } from "teleportal/encryption-key";
import {
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedSnapshot,
  encodeEncryptedUpdateMessages,
  getEmptyEncryptedStateVector,
} from "teleportal/protocol/encryption";
import type {
  DecodedEncryptedUpdatePayload,
  EncryptedSnapshot,
  EncryptedSyncStep2,
} from "teleportal/protocol/encryption";
import { UnstorageEncryptedDocumentStorage } from "./encrypted";

describe("UnstorageEncryptedDocumentStorage", () => {
  let storage: UnstorageEncryptedDocumentStorage;

  beforeEach(() => {
    storage = new UnstorageEncryptedDocumentStorage(createStorage());
  });

  it("stores snapshots and updates", async () => {
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
    const decoded = decodeFromSyncStep2(
      doc!.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);

    const state = decodeFromStateVector(doc!.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(1);
  });

  it("returns empty sync step for missing snapshot", async () => {
    const result = await storage.handleSyncStep1(
      "doc-1",
      getEmptyEncryptedStateVector(),
    );
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.updates.length).toBe(0);
    expect(decoded.snapshot).toBeNull();
  });
});
