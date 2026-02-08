import { beforeEach, describe, expect, it } from "bun:test";
import { EncryptedBinary } from "teleportal/encryption-key";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedSnapshot,
  encodeEncryptedUpdateMessages,
  encodeToStateVector,
  encodeToSyncStep2,
  getEmptyEncryptedStateVector,
  getEncryptedStateVector,
} from "teleportal/protocol/encryption";
import type {
  DecodedEncryptedUpdatePayload,
  EncryptedSnapshot,
  EncryptedSyncStep2,
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
    if (decoded.type === "update")
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
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
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
    const decoded = decodeFromSyncStep2(
      doc!.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);

    const state = decodeFromStateVector(doc!.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(1);
  });

  it("handleSyncStep1 with no document returns empty update and zero state", async () => {
    const result = await storage.handleSyncStep1(
      "doc-1",
      getEmptyEncryptedStateVector(),
    );
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot).toBeNull();
    expect(decoded.updates.length).toBe(0);
    const state = decodeFromStateVector(result.content.stateVector);
    expect(state.snapshotId).toBe("");
    expect(state.serverVersion).toBe(0);
  });

  it("handleSyncStep1 with same snapshotId and up-to-date serverVersion returns no snapshot and no updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );
    const oneUpdate: DecodedEncryptedUpdatePayload = {
      id: "u1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([1]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([oneUpdate]),
    );

    const stateVector = getEncryptedStateVector(snapshot.id, 1);
    const result = await storage.handleSyncStep1("doc-1", stateVector);
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot).toBeNull();
    expect(decoded.updates.length).toBe(0);
    const state = decodeFromStateVector(result.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(1);
  });

  it("handleSyncStep1 with same snapshotId but older serverVersion returns only newer updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );
    for (let i = 1; i <= 3; i++) {
      await storage.handleEncryptedUpdate(
        "doc-1",
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

    const stateVector = getEncryptedStateVector(snapshot.id, 1);
    const result = await storage.handleSyncStep1("doc-1", stateVector);
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot).toBeNull();
    expect(decoded.updates.length).toBe(2);
    expect(decoded.updates.map((u) => u.serverVersion)).toEqual([2, 3]);
  });

  it("handleSyncStep1 with different snapshotId returns full snapshot and all updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
        },
      ]),
    );

    const stateVector = encodeToStateVector({
      snapshotId: "other-snapshot",
      serverVersion: 0,
    });
    const result = await storage.handleSyncStep1("doc-1", stateVector);
    const decoded = decodeFromSyncStep2(
      result.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);
  });

  it("rejects update when snapshotId does not match active snapshot", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );

    const wrongSnapshotUpdate: DecodedEncryptedUpdatePayload = {
      id: "u1",
      snapshotId: "other-snapshot",
      timestamp: [1, 1],
      payload: new Uint8Array([1]) as EncryptedBinary,
    };
    await expect(
      storage.handleEncryptedUpdate(
        "doc-1",
        encodeEncryptedUpdateMessages([wrongSnapshotUpdate]),
      ),
    ).rejects.toThrow("Update snapshot does not match active snapshot");
  });

  it("rejects update when counter is out of order for same client", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot),
    );
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
        },
      ]),
    );

    const outOfOrder: DecodedEncryptedUpdatePayload = {
      id: "u2",
      snapshotId: snapshot.id,
      timestamp: [1, 3],
      payload: new Uint8Array([3]) as EncryptedBinary,
    };
    await expect(
      storage.handleEncryptedUpdate(
        "doc-1",
        encodeEncryptedUpdateMessages([outOfOrder]),
      ),
    ).rejects.toThrow("Update counter out of order");
  });

  it("skips snapshot when active exists but parent is missing (e.g. second client)", async () => {
    const snapshot1: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([1]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot1),
    );

    const snapshot2NoParent: EncryptedSnapshot = {
      id: "snapshot-2",
      parentSnapshotId: null,
      payload: new Uint8Array([2]) as EncryptedBinary,
    };
    const result = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot2NoParent),
    );
    expect(result).toBeNull();
    const meta = await storage.getDocumentMetadata("doc-1");
    expect(meta.activeSnapshotId).toBe("snapshot-1");
  });

  it("rejects snapshot when parent does not match active snapshot", async () => {
    const snapshot1: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([1]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot1),
    );

    const snapshot2WrongParent: EncryptedSnapshot = {
      id: "snapshot-2",
      parentSnapshotId: "wrong-parent",
      payload: new Uint8Array([2]) as EncryptedBinary,
    };
    await expect(
      storage.handleEncryptedUpdate(
        "doc-1",
        encodeEncryptedSnapshot(snapshot2WrongParent),
      ),
    ).rejects.toThrow("Snapshot parent does not match active snapshot");
  });

  it("accepts child snapshot when parent matches active", async () => {
    const snapshot1: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([1]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot1),
    );

    const snapshot2: EncryptedSnapshot = {
      id: "snapshot-2",
      parentSnapshotId: "snapshot-1",
      payload: new Uint8Array([2]) as EncryptedBinary,
    };
    const stored = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedSnapshot(snapshot2),
    );
    expect(stored).not.toBeNull();
    const doc = await storage.getDocument("doc-1");
    expect(doc?.metadata.activeSnapshotId).toBe("snapshot-2");
  });

  it("handleEncryptedSyncStep2 stores snapshot and updates and returns payloads", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    const updates: DecodedEncryptedUpdatePayload[] = [
      {
        id: "u1",
        snapshotId: snapshot.id,
        timestamp: [1, 1],
        payload: new Uint8Array([1]) as EncryptedBinary,
      },
    ];
    const syncStep2Encoded = encodeToSyncStep2({ snapshot, updates });
    const payloads = await storage.handleEncryptedSyncStep2(
      "doc-1",
      syncStep2Encoded as unknown as EncryptedSyncStep2,
    );
    expect(payloads.length).toBeGreaterThan(0);

    const doc = await storage.getDocument("doc-1");
    expect(doc).not.toBeNull();
    const decoded = decodeFromSyncStep2(
      doc!.content.update as unknown as EncryptedSyncStep2,
    );
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);
  });
});
