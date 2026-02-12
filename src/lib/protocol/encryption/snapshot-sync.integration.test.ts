import { beforeEach, describe, expect, it } from "bun:test";
import { EncryptedBinary } from "../../../encryption-key";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedSnapshot,
  encodeEncryptedUpdateMessages,
  encodeToStateVector,
  encodeToSyncStep2,
  getEmptyEncryptedStateVector,
} from "./encoding";
import { getEncryptedStateVector } from "./sync";
import type {
  DecodedEncryptedUpdatePayload,
  EncryptedSnapshot,
  EncryptedSyncStep2,
} from "./encoding";
import { EncryptedMemoryStorage } from "../../../storage/in-memory/encrypted";

/**
 * Integration tests for snapshot-based encrypted document sync.
 * Validates that client-provided snapshots and server-assigned versions
 * work correctly for sync step 1, sync step 2, and incremental updates.
 */
describe("snapshot-based encrypted sync integration", () => {
  let storage: EncryptedMemoryStorage;
  const key = "doc-1";

  beforeEach(() => {
    EncryptedMemoryStorage.docs.clear();
    storage = new EncryptedMemoryStorage();
  });

  it("full flow: client sends snapshot then updates, server assigns versions", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snap-initial",
      parentSnapshotId: null,
      payload: new Uint8Array([1, 2, 3]) as EncryptedBinary,
    };

    const snapshotPayload = await storage.handleEncryptedUpdate(
      key,
      encodeEncryptedSnapshot(snapshot),
    );
    expect(snapshotPayload).not.toBeNull();
    const decodedSnap = decodeEncryptedUpdate(snapshotPayload!);
    expect(decodedSnap.type).toBe("snapshot");

    const updates: DecodedEncryptedUpdatePayload[] = [
      {
        id: "u1",
        snapshotId: snapshot.id,
        timestamp: [1, 1],
        payload: new Uint8Array([10]) as EncryptedBinary,
      },
      {
        id: "u2",
        snapshotId: snapshot.id,
        timestamp: [1, 2],
        payload: new Uint8Array([11]) as EncryptedBinary,
      },
      {
        id: "u3",
        snapshotId: snapshot.id,
        timestamp: [1, 3],
        payload: new Uint8Array([12]) as EncryptedBinary,
      },
    ];

    for (const u of updates) {
      const out = await storage.handleEncryptedUpdate(
        key,
        encodeEncryptedUpdateMessages([u]),
      );
      expect(out).not.toBeNull();
      const decoded = decodeEncryptedUpdate(out!);
      expect(decoded.type).toBe("update");
      if (decoded.type === "update") {
        expect(decoded.updates[0].serverVersion).toBeGreaterThan(0);
      }
    }

    const doc = await storage.getDocument(key);
    expect(doc).not.toBeNull();
    const state = decodeFromStateVector(doc!.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(3);

    const syncDecoded = decodeFromSyncStep2(
      doc!.content.update as unknown as EncryptedSyncStep2,
    );
    expect(syncDecoded.snapshot?.id).toBe(snapshot.id);
    expect(syncDecoded.updates.length).toBe(3);
    expect(syncDecoded.updates.map((u) => u.serverVersion)).toEqual([1, 2, 3]);
  });

  it("new client sync step 1 with empty state receives snapshot and all updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snap-a",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(key, encodeEncryptedSnapshot(snapshot));
    await storage.handleEncryptedUpdate(
      key,
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
        },
        {
          id: "u2",
          snapshotId: snapshot.id,
          timestamp: [1, 2],
          payload: new Uint8Array([2]) as EncryptedBinary,
        },
      ]),
    );

    const result = await storage.handleSyncStep1(
      key,
      getEmptyEncryptedStateVector(),
    );
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(2);
    expect(decoded.updates[0].serverVersion).toBe(1);
    expect(decoded.updates[1].serverVersion).toBe(2);

    const state = decodeFromStateVector(result.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(2);
  });

  it("client with same snapshot but older version receives only newer updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snap-b",
      parentSnapshotId: null,
      payload: new Uint8Array([8]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(key, encodeEncryptedSnapshot(snapshot));
    for (let i = 1; i <= 5; i++) {
      await storage.handleEncryptedUpdate(
        key,
        encodeEncryptedUpdateMessages([
          {
            id: `u${i}`,
            snapshotId: snapshot.id,
            timestamp: [1, i],
            payload: new Uint8Array([i]) as EncryptedBinary,
          },
        ]),
      );
    }

    const stateVectorAt2 = getEncryptedStateVector(snapshot.id, 2);
    const result = await storage.handleSyncStep1(key, stateVectorAt2);
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot).toBeNull();
    expect(decoded.updates.length).toBe(3);
    expect(decoded.updates.map((u) => u.serverVersion)).toEqual([3, 4, 5]);
  });

  it("client with different snapshot receives full snapshot and all updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snap-c",
      parentSnapshotId: null,
      payload: new Uint8Array([7]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(key, encodeEncryptedSnapshot(snapshot));
    await storage.handleEncryptedUpdate(
      key,
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [2, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
        },
      ]),
    );

    const otherStateVector = encodeToStateVector({
      snapshotId: "other-snapshot",
      serverVersion: 10,
    });
    const result = await storage.handleSyncStep1(key, otherStateVector);
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.snapshot?.payload).toEqual(snapshot.payload);
    expect(decoded.updates.length).toBe(1);
    expect(decoded.updates[0].serverVersion).toBe(1);
  });

  it("sync step 2 with snapshot and updates establishes document and versions", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snap-d",
      parentSnapshotId: null,
      payload: new Uint8Array([6]) as EncryptedBinary,
    };
    const updates: DecodedEncryptedUpdatePayload[] = [
      {
        id: "u1",
        snapshotId: snapshot.id,
        timestamp: [1, 1],
        payload: new Uint8Array([1]) as EncryptedBinary,
      },
      {
        id: "u2",
        snapshotId: snapshot.id,
        timestamp: [1, 2],
        payload: new Uint8Array([2]) as EncryptedBinary,
      },
    ];
    const syncStep2Encoded = encodeToSyncStep2({ snapshot, updates });

    const payloads = await storage.handleEncryptedSyncStep2(
      key,
      syncStep2Encoded as EncryptedSyncStep2,
    );
    expect(payloads.length).toBeGreaterThan(0);

    const doc = await storage.getDocument(key);
    expect(doc).not.toBeNull();
    expect(doc?.metadata.activeSnapshotId).toBe(snapshot.id);
    expect(doc?.metadata.activeSnapshotVersion).toBe(2);

    const state = decodeFromStateVector(doc!.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(2);
  });
});
