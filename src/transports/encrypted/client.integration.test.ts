import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createEncryptionKey } from "teleportal/encryption-key";
import { decodeEncryptedUpdate } from "teleportal/protocol/encryption";
import type { DecodedEncryptedUpdatePayload } from "teleportal/protocol/encryption";
import type { Update } from "teleportal/protocol";
import { EncryptedMemoryStorage } from "teleportal/storage";
import { EncryptionClient } from "./client";

describe("encrypted client integration", () => {
  let storage: EncryptedMemoryStorage;

  beforeEach(() => {
    EncryptedMemoryStorage.docs.clear();
    storage = new EncryptedMemoryStorage();
  });

  it("acknowledges server-versioned updates after snapshot", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({ document: "doc-1", ydoc, key });

    const stateUpdates: Array<{
      snapshotId: string | null;
      serverVersion: number;
    }> = [];
    let acknowledged: DecodedEncryptedUpdatePayload | null = null;

    client.on("state-updated", (state) => {
      stateUpdates.push(state);
    });
    client.on("update-acknowledged", (update) => {
      acknowledged = update;
    });

    ydoc.getText("body").insert(0, "hello");
    const initialUpdate = Y.encodeStateAsUpdateV2(ydoc) as Update;
    const snapshotMessage = await client.onUpdate(initialUpdate);

    if (snapshotMessage.type !== "doc" || snapshotMessage.payload.type !== "update") {
      throw new Error("Expected snapshot update message");
    }

    const storedSnapshotPayload = await storage.handleEncryptedUpdate(
      "doc-1",
      snapshotMessage.payload.update,
    );
    expect(storedSnapshotPayload).not.toBeNull();
    await client.handleUpdate(storedSnapshotPayload!);

    const decodedSnapshot = decodeEncryptedUpdate(storedSnapshotPayload!);
    if (decodedSnapshot.type !== "snapshot") {
      throw new Error("Expected snapshot payload");
    }
    const snapshotId = decodedSnapshot.snapshot.id;
    expect(snapshotId).toBeTruthy();

    ydoc.getText("body").insert(5, " world");
    const secondUpdate = Y.encodeStateAsUpdateV2(ydoc) as Update;
    const updateMessage = await client.onUpdate(secondUpdate);

    if (updateMessage.type !== "doc" || updateMessage.payload.type !== "update") {
      throw new Error("Expected update message");
    }

    const storedUpdatePayload = await storage.handleEncryptedUpdate(
      "doc-1",
      updateMessage.payload.update,
    );
    expect(storedUpdatePayload).not.toBeNull();

    const decodedUpdate = decodeEncryptedUpdate(storedUpdatePayload!);
    if (decodedUpdate.type !== "update") {
      throw new Error("Expected update payload");
    }
    expect(decodedUpdate.updates[0].serverVersion).toBe(1);
    expect(decodedUpdate.updates[0].snapshotId).toBe(snapshotId);

    await client.handleUpdate(storedUpdatePayload!);

    expect(acknowledged?.serverVersion).toBe(1);
    expect(acknowledged?.snapshotId).toBe(snapshotId);

    const lastState = stateUpdates[stateUpdates.length - 1];
    expect(lastState?.snapshotId).toBe(snapshotId);
    expect(lastState?.serverVersion).toBe(1);

    expect(ydoc.getText("body").toString()).toBe("hello world");
  });
});
