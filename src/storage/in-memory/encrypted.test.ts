import { beforeEach, describe, expect, it } from "bun:test";
import { EncryptedBinary } from "teleportal/encryption-key";
import type { EncodedContentMap } from "../types";
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
import { digest } from "lib0/hash/sha256";
import { toBase64 } from "lib0/buffer";
import {
  createContentAttribute,
  createContentMapFromContentIds,
  createContentIds,
  decodeContentMap,
  encodeContentMap,
  getEmptyEncodedContentIds,
  IdSet,
} from "teleportal/attribution";
import type { VersionedUpdate, Update } from "teleportal";
import { EncryptedMemoryStorage } from "./encrypted";

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  return { version: 2, data: bytes as Update } as VersionedUpdate;
}

describe("EncryptedMemoryStorage", () => {
  let storage: EncryptedMemoryStorage;

  beforeEach(() => {
    EncryptedMemoryStorage.docs.clear();
    EncryptedMemoryStorage.attributionMaps.clear();
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
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));

    const updatePayload: DecodedEncryptedUpdatePayload = {
      id: "update-1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([5, 6]) as EncryptedBinary,
      contentIds: getEmptyEncodedContentIds(),
    };
    const storedPayload = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([updatePayload]),
    );

    expect(storedPayload).toBeDefined();
    const decoded = decodeEncryptedUpdate(storedPayload!);
    expect(decoded.type).toBe("update");
    if (decoded.type === "update") expect(decoded.updates[0].serverVersion).toBe(1);
  });

  it("returns snapshot + updates on sync step 1 when client is empty", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));

    const updatePayload: DecodedEncryptedUpdatePayload = {
      id: "update-1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([5, 6]) as EncryptedBinary,
      contentIds: getEmptyEncodedContentIds(),
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedUpdateMessages([updatePayload]));

    const result = await storage.handleSyncStep1("doc-1", getEmptyEncryptedStateVector());
    const decoded = decodeFromSyncStep2(result.content.update as unknown as EncryptedSyncStep2);
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);
  });

  it("builds document with snapshot and updates", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));

    const updatePayload: DecodedEncryptedUpdatePayload = {
      id: "update-1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([5, 6]) as EncryptedBinary,
      contentIds: getEmptyEncodedContentIds(),
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedUpdateMessages([updatePayload]));

    const doc = await storage.getDocument("doc-1");
    expect(doc).not.toBeNull();
    const decoded = decodeFromSyncStep2(doc!.content.update as unknown as EncryptedSyncStep2);
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);

    const state = decodeFromStateVector(doc!.content.stateVector);
    expect(state.snapshotId).toBe(snapshot.id);
    expect(state.serverVersion).toBe(1);
  });

  it("handleSyncStep1 with no document returns empty update and zero state", async () => {
    const result = await storage.handleSyncStep1("doc-1", getEmptyEncryptedStateVector());
    const decoded = decodeFromSyncStep2(result.content.update as unknown as EncryptedSyncStep2);
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
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));
    const oneUpdate: DecodedEncryptedUpdatePayload = {
      id: "u1",
      snapshotId: snapshot.id,
      timestamp: [1, 1],
      payload: new Uint8Array([1]) as EncryptedBinary,
      contentIds: getEmptyEncodedContentIds(),
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedUpdateMessages([oneUpdate]));

    const stateVector = getEncryptedStateVector(snapshot.id, 1);
    const result = await storage.handleSyncStep1("doc-1", stateVector);
    const decoded = decodeFromSyncStep2(result.content.update as unknown as EncryptedSyncStep2);
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
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));
    for (let i = 1; i <= 3; i++) {
      await storage.handleEncryptedUpdate(
        "doc-1",
        encodeEncryptedUpdateMessages([
          {
            id: `u${i}`,
            snapshotId: snapshot.id,
            timestamp: [1, i],
            payload: new Uint8Array([i]) as EncryptedBinary,
            contentIds: getEmptyEncodedContentIds(),
          },
        ]),
      );
    }

    const stateVector = getEncryptedStateVector(snapshot.id, 1);
    const result = await storage.handleSyncStep1("doc-1", stateVector);
    const decoded = decodeFromSyncStep2(result.content.update as unknown as EncryptedSyncStep2);
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
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );

    const stateVector = encodeToStateVector({
      snapshotId: "other-snapshot",
      serverVersion: 0,
    });
    const result = await storage.handleSyncStep1("doc-1", stateVector);
    const decoded = decodeFromSyncStep2(result.content.update as unknown as EncryptedSyncStep2);
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);
  });

  it("rejects update when snapshotId does not match active snapshot", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));

    const wrongSnapshotUpdate: DecodedEncryptedUpdatePayload = {
      id: "u1",
      snapshotId: "other-snapshot",
      timestamp: [1, 1],
      payload: new Uint8Array([1]) as EncryptedBinary,
      contentIds: getEmptyEncodedContentIds(),
    };
    const result = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([wrongSnapshotUpdate]),
    );
    expect(result).toBeNull();
  });

  it("accepts updates with counter gaps (non-sequential)", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );

    // Counter jumps from 1 to 3 (gap) — should be accepted
    const gapped: DecodedEncryptedUpdatePayload = {
      id: "u2",
      snapshotId: snapshot.id,
      timestamp: [1, 3],
      payload: new Uint8Array([3]) as EncryptedBinary,
      contentIds: getEmptyEncodedContentIds(),
    };
    const result = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([gapped]),
    );
    expect(result).not.toBeNull();
  });

  it("skips duplicate updates (counter <= lastCounter)", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [1, 5],
          payload: new Uint8Array([1]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );

    // Re-send with counter 5 (equal) and counter 3 (less) — both should be skipped
    const duplicate = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u1-dup",
          snapshotId: snapshot.id,
          timestamp: [1, 5],
          payload: new Uint8Array([5]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
        {
          id: "u1-old",
          snapshotId: snapshot.id,
          timestamp: [1, 3],
          payload: new Uint8Array([3]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );
    // All updates were duplicates, so nothing stored → null
    expect(duplicate).toBeNull();

    // Verify only the original update is stored
    const state = decodeFromStateVector((await storage.getDocument("doc-1"))!.content.stateVector);
    expect(state.serverVersion).toBe(1);
  });

  it("accepts a large counter gap (simulates batched client reconnect)", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));

    // Client sends counter 1
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u1",
          snapshotId: snapshot.id,
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );

    // Client reconnects after local batching consumed many clock ticks — counter jumps to 825
    const result = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u2",
          snapshotId: snapshot.id,
          timestamp: [1, 825],
          payload: new Uint8Array([2]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );
    expect(result).not.toBeNull();

    // Counter 825 is now the last — next update at 826 should also work
    const next = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "u3",
          snapshotId: snapshot.id,
          timestamp: [1, 826],
          payload: new Uint8Array([3]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );
    expect(next).not.toBeNull();

    const state = decodeFromStateVector((await storage.getDocument("doc-1"))!.content.stateVector);
    expect(state.serverVersion).toBe(3);
  });

  it("handles multiple clients with independent counter sequences", async () => {
    const snapshot: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([9]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot));

    // Client A sends counter 1, then jumps to 10
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "a1",
          snapshotId: snapshot.id,
          timestamp: [100, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );
    await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "a2",
          snapshotId: snapshot.id,
          timestamp: [100, 10],
          payload: new Uint8Array([2]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );

    // Client B sends counter 1 — independent of client A
    const resultB = await storage.handleEncryptedUpdate(
      "doc-1",
      encodeEncryptedUpdateMessages([
        {
          id: "b1",
          snapshotId: snapshot.id,
          timestamp: [200, 1],
          payload: new Uint8Array([3]) as EncryptedBinary,
          contentIds: getEmptyEncodedContentIds(),
        },
      ]),
    );
    expect(resultB).not.toBeNull();

    const state = decodeFromStateVector((await storage.getDocument("doc-1"))!.content.stateVector);
    expect(state.serverVersion).toBe(3);
  });

  it("skips snapshot when active exists but parent is missing (e.g. second client)", async () => {
    const snapshot1: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([1]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot1));

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
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot1));

    const snapshot2WrongParent: EncryptedSnapshot = {
      id: "snapshot-2",
      parentSnapshotId: "wrong-parent",
      payload: new Uint8Array([2]) as EncryptedBinary,
    };
    await expect(
      storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot2WrongParent)),
    ).rejects.toThrow("Snapshot parent does not match active snapshot");
  });

  it("accepts child snapshot when parent matches active", async () => {
    const snapshot1: EncryptedSnapshot = {
      id: "snapshot-1",
      parentSnapshotId: null,
      payload: new Uint8Array([1]) as EncryptedBinary,
    };
    await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot1));

    const snapshot2: EncryptedSnapshot = {
      id: "snapshot-2",
      parentSnapshotId: "snapshot-1",
      payload: new Uint8Array([2]) as EncryptedBinary,
    };
    const stored = await storage.handleEncryptedUpdate("doc-1", encodeEncryptedSnapshot(snapshot2));
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
        contentIds: getEmptyEncodedContentIds(),
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
    const decoded = decodeFromSyncStep2(doc!.content.update as unknown as EncryptedSyncStep2);
    expect(decoded.snapshot?.id).toBe(snapshot.id);
    expect(decoded.updates.length).toBe(1);
  });

  describe("attribution", () => {
    const attrSnapshotId = "attr-snapshot";

    async function setupSnapshot(key: string) {
      const snapshot: EncryptedSnapshot = {
        id: attrSnapshotId,
        parentSnapshotId: null,
        payload: new Uint8Array([0]) as EncryptedBinary,
      };
      await storage.handleEncryptedUpdate(key, encodeEncryptedSnapshot(snapshot));
    }

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

    it("should store and retrieve attribution via handleUpdate", async () => {
      const key = "attr-doc-1";
      await setupSnapshot(key);
      const payload = new Uint8Array([10, 20, 30]) as EncryptedBinary;
      const messageId = toBase64(digest(payload));
      const message: DecodedEncryptedUpdatePayload = {
        id: messageId,
        snapshotId: attrSnapshotId,
        timestamp: [1, 0],
        payload,
        contentIds: getEmptyEncodedContentIds(),
      };
      const update = encodeEncryptedUpdateMessages([message]);
      const attribution = makeAttribution("user-1");

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
      await setupSnapshot(key);
      const payload = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const messageId = toBase64(digest(payload));
      const message: DecodedEncryptedUpdatePayload = {
        id: messageId,
        snapshotId: attrSnapshotId,
        timestamp: [1, 0],
        payload,
        contentIds: getEmptyEncodedContentIds(),
      };
      const update = encodeEncryptedUpdateMessages([message]);

      await storage.handleUpdate(key, versionedUpdate(update));

      const result = await storage.retrieveAttribution(key);
      expect(result).toBeNull();
    });

    it("should merge multiple attributions on retrieve", async () => {
      const key = "attr-doc-3";
      await setupSnapshot(key);
      const payload1 = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const payload2 = new Uint8Array([4, 5, 6]) as EncryptedBinary;
      const msg1: DecodedEncryptedUpdatePayload = {
        id: toBase64(digest(payload1)),
        snapshotId: attrSnapshotId,
        timestamp: [1, 0],
        payload: payload1,
        contentIds: getEmptyEncodedContentIds(),
      };
      const msg2: DecodedEncryptedUpdatePayload = {
        id: toBase64(digest(payload2)),
        snapshotId: attrSnapshotId,
        timestamp: [2, 0],
        payload: payload2,
        contentIds: getEmptyEncodedContentIds(),
      };

      await storage.handleUpdate(
        key,
        versionedUpdate(encodeEncryptedUpdateMessages([msg1])),
        makeAttribution("user-1", 1, 0, 5),
      );
      await storage.handleUpdate(
        key,
        versionedUpdate(encodeEncryptedUpdateMessages([msg2])),
        makeAttribution("user-2", 2, 0, 3),
      );

      const retrieved = await storage.retrieveAttribution(key);
      expect(retrieved).not.toBeNull();
      const map = decodeContentMap(retrieved!);
      expect(map.inserts.clients.size).toBe(2);
    });

    it("should clean up attribution on deleteDocument", async () => {
      const key = "attr-doc-4";
      await setupSnapshot(key);
      const payload = new Uint8Array([1, 2, 3]) as EncryptedBinary;
      const msg: DecodedEncryptedUpdatePayload = {
        id: toBase64(digest(payload)),
        snapshotId: attrSnapshotId,
        timestamp: [1, 0],
        payload,
        contentIds: getEmptyEncodedContentIds(),
      };

      await storage.handleUpdate(
        key,
        versionedUpdate(encodeEncryptedUpdateMessages([msg])),
        makeAttribution("user-1"),
      );
      expect(await storage.retrieveAttribution(key)).not.toBeNull();

      await storage.deleteDocument(key);
      expect(await storage.retrieveAttribution(key)).toBeNull();
    });
  });
});
