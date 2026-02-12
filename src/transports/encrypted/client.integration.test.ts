import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createEncryptionKey } from "teleportal/encryption-key";
import {
  decodeEncryptedUpdate,
  decodeFromSyncStep2,
} from "teleportal/protocol/encryption";
import type {
  DecodedEncryptedUpdatePayload,
  EncryptedSyncStep2,
} from "teleportal/protocol/encryption";
import type { Message, Update } from "teleportal/protocol";
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
      acknowledged = update as DecodedEncryptedUpdatePayload;
    });

    ydoc.getText("body").insert(0, "hello");
    const initialUpdate = Y.encodeStateAsUpdateV2(ydoc) as Update;
    const snapshotMessage = await client.onUpdate(initialUpdate);

    if (
      snapshotMessage.type !== "doc" ||
      snapshotMessage.payload.type !== "update"
    ) {
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

    if (
      updateMessage.type !== "doc" ||
      updateMessage.payload.type !== "update"
    ) {
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

    const ack = acknowledged as DecodedEncryptedUpdatePayload | null;
    expect(ack?.serverVersion).toBe(1);
    expect(ack?.snapshotId).toBe(snapshotId);

    const lastState = stateUpdates[stateUpdates.length - 1];
    expect(lastState?.snapshotId).toBe(snapshotId);
    expect(lastState?.serverVersion).toBe(1);

    expect(ydoc.getText("body").toString()).toBe("hello world");
  });

  it("returns compaction snapshot after initial sync (sync-step-2 with snapshot + updates)", async () => {
    const key = await createEncryptionKey();
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocA,
      key,
    });

    ydocA.getText("body").insert(0, "hello");
    const snapshotMsg = await clientA.onUpdate(
      Y.encodeStateAsUpdateV2(ydocA) as Update,
    );
    if (snapshotMsg.type !== "doc" || snapshotMsg.payload.type !== "update") {
      throw new Error("Expected doc update");
    }
    await storage.handleEncryptedUpdate("doc-1", snapshotMsg.payload.update);

    ydocA.getText("body").insert(5, " world");
    const updateMsg = await clientA.onUpdate(
      Y.encodeStateAsUpdateV2(ydocA) as Update,
    );
    if (updateMsg.type !== "doc" || updateMsg.payload.type !== "update") {
      throw new Error("Expected doc update");
    }
    await storage.handleEncryptedUpdate("doc-1", updateMsg.payload.update);

    const doc = await storage.getDocument("doc-1");
    expect(doc).not.toBeNull();
    const syncStep2Payload = doc!.content
      .update as unknown as EncryptedSyncStep2;
    const decoded = decodeFromSyncStep2(syncStep2Payload);
    expect(decoded.snapshot).not.toBeNull();
    expect(decoded.updates.length).toBeGreaterThan(0);

    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
    });
    const compaction = await clientB.handleSyncStep2(syncStep2Payload);

    expect(compaction).toBeDefined();
    if (!compaction || compaction.type !== "doc") {
      throw new Error("Expected doc message");
    }
    if (compaction.payload.type !== "update") {
      throw new Error("Expected update payload");
    }
    expect(compaction.payload.type).toBe("update");
    const compactionDecoded = decodeEncryptedUpdate(compaction.payload.update);
    expect(compactionDecoded.type).toBe("snapshot");
    expect(ydocB.getText("body").toString()).toBe("hello world");

    const stored = await storage.handleEncryptedUpdate(
      "doc-1",
      compaction.payload.update,
    );
    expect(stored).not.toBeNull();
    const docAfter = await storage.getDocument("doc-1");
    expect(docAfter).not.toBeNull();
    if (compactionDecoded.type === "snapshot") {
      expect(docAfter!.metadata.activeSnapshotId).toBe(
        compactionDecoded.snapshot.id,
      );
    }
  });

  it("sends compaction snapshot periodically when snapshotIntervalMs > 0", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({
      document: "doc-1",
      ydoc,
      key,
      snapshotIntervalMs: 20,
    });

    const sent: Message[] = [];
    client.on("send-message", (message) => {
      sent.push(message);
    });

    ydoc.getText("body").insert(0, "hello");
    await client.onUpdate(Y.encodeStateAsUpdateV2(ydoc) as Update);
    expect(sent.length).toBe(0);

    ydoc.getText("body").insert(5, "!");
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe("doc");
    if (sent[0].type === "doc" && sent[0].payload.type === "update") {
      expect(sent[0].payload.type).toBe("update");
      const decoded = decodeEncryptedUpdate(sent[0].payload.update);
      expect(decoded.type).toBe("snapshot");
    }

    client.destroy();
  });

  it("does not send periodic snapshot when there are no changes since last snapshot", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({
      document: "doc-1",
      ydoc,
      key,
      snapshotIntervalMs: 15,
    });

    const sent: Message[] = [];
    client.on("send-message", (message) => {
      sent.push(message);
    });

    ydoc.getText("body").insert(0, "hello");
    await client.onUpdate(Y.encodeStateAsUpdateV2(ydoc) as Update);
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(sent.length).toBe(0);
    client.destroy();
  });

  it("does not schedule periodic snapshot when snapshotIntervalMs is 0", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({
      document: "doc-1",
      ydoc,
      key,
      snapshotIntervalMs: 0,
    });

    const sent: Message[] = [];
    client.on("send-message", (message) => {
      sent.push(message);
    });

    ydoc.getText("body").insert(0, "x");
    await client.onUpdate(Y.encodeStateAsUpdateV2(ydoc) as Update);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(sent.length).toBe(0);
  });
});
