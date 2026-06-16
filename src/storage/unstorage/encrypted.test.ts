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
import { digest } from "lib0/hash/sha256";
import { toBase64 } from "lib0/buffer";
import {
  createContentAttribute,
  createContentIds,
  createContentMapFromContentIds,
  decodeContentMap,
  encodeContentMap,
  getEmptyEncodedContentIds,
  IdSet,
} from "teleportal/attribution";
import type { VersionedUpdate, Update } from "teleportal";
import { UnstorageEncryptedDocumentStorage } from "./encrypted";
import type { EncodedContentMap } from "../types";

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  return { version: 2, data: bytes as Update } as VersionedUpdate;
}

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

  it("returns empty sync step for missing snapshot", async () => {
    const result = await storage.handleSyncStep1("doc-1", getEmptyEncryptedStateVector());
    const decoded = decodeFromSyncStep2(result.content.update as unknown as EncryptedSyncStep2);
    expect(decoded.updates.length).toBe(0);
    expect(decoded.snapshot).toBeNull();
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
