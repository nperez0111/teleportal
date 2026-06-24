import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createEncryptionKey } from "teleportal/encryption-key";
import {
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
  encryptUpdateContent,
} from "teleportal/protocol/encryption";
import type {
  Message,
  Update,
  VersionedUpdate,
  VersionedSyncStep2Update,
} from "teleportal/protocol";
import { MemoryDocumentStorage } from "../../storage/in-memory/document-storage";
import { EncryptionClient } from "./client";

describe("encrypted client integration", () => {
  let storage: MemoryDocumentStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    storage = new MemoryDocumentStorage(true);
  });

  // ── Encrypt / decrypt round-trip ──────────────────────────────────────────

  it("encrypts and decrypts an update round-trip", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({ document: "doc-1", ydoc, key });

    ydoc.getText("body").insert(0, "hello world");
    const update = Y.encodeStateAsUpdate(ydoc);

    const encrypted = await client.encryptUpdate(update);
    expect(encrypted).not.toEqual(update);
    expect(encrypted.byteLength).toBeGreaterThan(0);

    const decrypted = await client.decryptUpdate(encrypted);
    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(update));
  });

  it("onUpdate produces a content-encrypted doc message", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({ document: "doc-1", ydoc, key });

    ydoc.getText("body").insert(0, "hello");
    const versionedUpdate = {
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydoc) as Update,
    } as VersionedUpdate;

    const msg = await client.onUpdate(versionedUpdate);
    expect(msg.type).toBe("doc");
    if (msg.type !== "doc") throw new Error("Expected doc message");
    expect(msg.payload.type).toBe("update");

    if (msg.payload.type !== "update") throw new Error("Expected update payload");
    const decoded = decodeContentEncryptedPayload(msg.payload.update.data as Update);
    expect(decoded.structureUpdate.byteLength).toBeGreaterThan(0);
    expect(decoded.encryptedSidecars.length).toBe(1);
  });

  // ── Sync handshake ────────────────────────────────────────────────────────

  it("start() returns a sync-step-1 message with the state vector", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({ document: "doc-1", ydoc, key });

    const msg = await client.start();
    expect(msg.type).toBe("doc");
    if (msg.type !== "doc") throw new Error("Expected doc message");
    expect(msg.payload.type).toBe("sync-step-1");

    if (msg.payload.type !== "sync-step-1") throw new Error("Expected sync-step-1");
    const sv = msg.payload.sv;
    expect(sv).toBeInstanceOf(Uint8Array);
    // The state vector from an empty Y.Doc should equal Y.encodeStateVector(ydoc)
    expect(new Uint8Array(sv)).toEqual(new Uint8Array(Y.encodeStateVector(ydoc)));
  });

  it("handleSyncStep1 responds with a content-encrypted sync-step-2", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({ document: "doc-1", ydoc, key });

    ydoc.getText("body").insert(0, "local content");

    // Simulate the server echoing back an empty state vector (new doc)
    const emptyStateVector = Y.encodeStateVector(new Y.Doc());
    const response = await client.handleSyncStep1(emptyStateVector);

    expect(response.type).toBe("doc");
    if (response.type !== "doc") throw new Error("Expected doc message");
    expect(response.payload.type).toBe("sync-step-2");

    if (response.payload.type !== "sync-step-2") throw new Error("Expected sync-step-2");
    const decoded = decodeContentEncryptedPayload(
      response.payload.update.data as unknown as Update,
    );
    expect(decoded.structureUpdate.byteLength).toBeGreaterThan(0);
    expect(decoded.encryptedSidecars.length).toBe(1);
  });

  // ── handleSyncStep2: apply server diff ────────────────────────────────────

  it("handleSyncStep2 decrypts and applies the server diff", async () => {
    const key = await createEncryptionKey();

    // Client A produces content
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({ document: "doc-1", ydoc: ydocA, key });

    ydocA.getText("body").insert(0, "from server");
    const updateMsg = await clientA.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocA) as Update,
    } as VersionedUpdate);

    if (updateMsg.type !== "doc" || updateMsg.payload.type !== "update") {
      throw new Error("Expected doc update");
    }

    // Store update on server
    await storage.handleUpdate("doc-1", {
      version: 2,
      data: updateMsg.payload.update.data,
    } as unknown as VersionedUpdate);

    // Client B connects and receives sync-step-2 from storage
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({ document: "doc-1", ydoc: ydocB, key });

    const doc = await storage.handleSyncStep1("doc-1", Y.encodeStateVector(ydocB) as any);
    await clientB.handleSyncStep2({
      version: 2,
      data: doc.content.update,
    } as unknown as VersionedSyncStep2Update);

    expect(ydocB.getText("body").toString()).toBe("from server");
  });

  // ── handleUpdate: apply peer update ───────────────────────────────────────

  it("handleUpdate decrypts and applies an incremental peer update", async () => {
    const key = await createEncryptionKey();
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({ document: "doc-1", ydoc: ydocA, key });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({ document: "doc-1", ydoc: ydocB, key });

    ydocA.getText("body").insert(0, "peer update");
    const msg = await clientA.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocA) as Update,
    } as VersionedUpdate);

    if (msg.type !== "doc" || msg.payload.type !== "update") {
      throw new Error("Expected doc update");
    }

    // Simulate server broadcast: B receives the raw encrypted update
    await clientB.handleUpdate(msg.payload.update as unknown as VersionedUpdate);
    expect(ydocB.getText("body").toString()).toBe("peer update");
  });

  // ── Multiple sequential updates ──────────────────────────────────────────

  it("handles multiple sequential updates correctly", async () => {
    const key = await createEncryptionKey();
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({ document: "doc-1", ydoc: ydocA, key });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({ document: "doc-1", ydoc: ydocB, key });

    // First edit
    ydocA.getText("body").insert(0, "hello");
    const msg1 = await clientA.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocA) as Update,
    } as VersionedUpdate);

    if (msg1.type !== "doc" || msg1.payload.type !== "update") throw new Error("bad msg");
    await clientB.handleUpdate(msg1.payload.update as unknown as VersionedUpdate);
    expect(ydocB.getText("body").toString()).toBe("hello");

    // Second edit
    ydocA.getText("body").insert(5, " world");
    const msg2 = await clientA.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocA) as Update,
    } as VersionedUpdate);

    if (msg2.type !== "doc" || msg2.payload.type !== "update") throw new Error("bad msg");
    await clientB.handleUpdate(msg2.payload.update as unknown as VersionedUpdate);
    expect(ydocB.getText("body").toString()).toBe("hello world");
  });

  // ── send-message event ────────────────────────────────────────────────────

  it("emits send-message only when explicitly invoked (no automatic snapshots)", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({ document: "doc-1", ydoc, key });

    const sent: Message[] = [];
    client.on("send-message", (message) => {
      sent.push(message);
    });

    ydoc.getText("body").insert(0, "some text");
    await client.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydoc) as Update,
    } as VersionedUpdate);

    // The client should not auto-emit send-message events; onUpdate returns messages
    // synchronously rather than emitting them (no snapshot timer, no auto-send).
    await new Promise<void>((r) => setTimeout(r, 1));
    expect(sent.length).toBe(0);
  });

  // ── Storage round-trip ────────────────────────────────────────────────────

  it("encrypted update survives storage round-trip and restores content", async () => {
    const key = await createEncryptionKey();
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({ document: "doc-1", ydoc: ydocA, key });

    ydocA.getText("body").insert(0, "stored content");
    const msg = await clientA.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocA) as Update,
    } as VersionedUpdate);

    if (msg.type !== "doc" || msg.payload.type !== "update") throw new Error("bad msg");

    // Store in encrypted storage
    await storage.handleUpdate("doc-1", {
      version: 2,
      data: msg.payload.update.data,
    } as unknown as VersionedUpdate);
    // Verify state was persisted
    const storedState = await storage.getDocumentState("doc-1");
    expect(storedState).not.toBeNull();

    // New client retrieves document from storage
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({ document: "doc-1", ydoc: ydocB, key });

    const doc = await storage.handleSyncStep1("doc-1", Y.encodeStateVector(ydocB) as any);
    await clientB.handleSyncStep2({
      version: 2,
      data: doc.content.update,
    } as unknown as VersionedSyncStep2Update);

    expect(ydocB.getText("body").toString()).toBe("stored content");
  });

  // ── Constructor defaults ──────────────────────────────────────────────────

  it("creates a default Y.Doc and Awareness when not provided", async () => {
    const key = await createEncryptionKey();
    const client = new EncryptionClient({ document: "doc-1", key });

    expect(client.ydoc).toBeDefined();
    expect(client.awareness).toBeDefined();
    expect(client.document).toBe("doc-1");

    // Should be usable
    client.ydoc.getText("body").insert(0, "test");
    const msg = await client.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(client.ydoc) as Update,
    } as VersionedUpdate);
    expect(msg.type).toBe("doc");
  });

  it("destroy is safe to call multiple times", async () => {
    const key = await createEncryptionKey();
    const client = new EncryptionClient({ document: "doc-1", key });
    client.destroy();
    client.destroy(); // should not throw
  });

  // ── Custom encrypt/decrypt functions ──────────────────────────────────────

  it("supports custom encryptUpdate and decryptUpdate functions", async () => {
    const key = await createEncryptionKey();
    let encryptCalled = false;
    let decryptCalled = false;

    const { encryptUpdate, decryptUpdate } = await import("teleportal/encryption-key");

    const client = new EncryptionClient({
      document: "doc-1",
      key,
      encryptUpdate: async (k, data) => {
        encryptCalled = true;
        return encryptUpdate(k, data);
      },
      decryptUpdate: async (k, data) => {
        decryptCalled = true;
        return decryptUpdate(k, data);
      },
    });

    // The custom encryptUpdate/decryptUpdate are used via the public
    // encryptUpdate()/decryptUpdate() helpers, not by onUpdate internally.
    const plaintext = new Uint8Array([1, 2, 3]);
    const encrypted = await client.encryptUpdate(plaintext);
    expect(encryptCalled).toBe(true);

    const decrypted = await client.decryptUpdate(encrypted);
    expect(decryptCalled).toBe(true);
    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(plaintext));
  });

  // ── Client-side compaction ────────────────────────────────────────────────

  it("createCompactedSidecar merges multiple sidecars into one", async () => {
    const key = await createEncryptionKey();

    // Use two independent clients so sidecars have distinct (clientId, clock) entries
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({ document: "doc-1", ydoc: ydocA, key });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({ document: "doc-1", ydoc: ydocB, key });

    // Client A writes "hello"
    ydocA.getText("body").insert(0, "hello");
    const msg1 = await clientA.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocA) as Update,
    } as VersionedUpdate);
    if (msg1.type !== "doc" || msg1.payload.type !== "update") throw new Error("bad msg");
    await storage.handleUpdate("doc-1", {
      version: 2,
      data: msg1.payload.update.data,
    } as unknown as VersionedUpdate);

    // Client B writes "world" (independent update, different client ID)
    ydocB.getText("body").insert(0, "world");
    const msg2 = await clientB.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocB) as Update,
    } as VersionedUpdate);
    if (msg2.type !== "doc" || msg2.payload.type !== "update") throw new Error("bad msg");
    await storage.handleUpdate("doc-1", {
      version: 2,
      data: msg2.payload.update.data,
    } as unknown as VersionedUpdate);

    // Server has 2 sidecars
    let state = await storage.getDocumentState("doc-1");
    expect(state!.sidecars.length).toBe(2);

    // Client C syncs and compacts
    const ydocC = new Y.Doc();
    const clientC = new EncryptionClient({ document: "doc-1", ydoc: ydocC, key });

    const doc = await storage.handleSyncStep1("doc-1", Y.encodeStateVector(ydocC) as any);
    const decoded = decodeContentEncryptedPayload(doc.content.update as unknown as Update);

    // Compact the sidecars
    const compacted = await clientC.createCompactedSidecar(
      decoded.encryptedSidecars,
      decoded.structureUpdate,
    );
    expect(compacted).not.toBeNull();

    // Apply to storage
    const baseSV = Y.encodeStateVectorFromUpdateV2(state!.update);
    const accepted = await storage.handleCompaction("doc-1", compacted!, baseSV);
    expect(accepted).toBe(true);

    // Server now has 1 sidecar
    state = await storage.getDocumentState("doc-1");
    expect(state!.sidecars.length).toBe(1);

    // A new client can still sync and get the correct content
    const ydocD = new Y.Doc();
    const clientD = new EncryptionClient({ document: "doc-1", ydoc: ydocD, key });
    const doc2 = await storage.handleSyncStep1("doc-1", Y.encodeStateVector(ydocD) as any);
    await clientD.handleSyncStep2({
      version: 2,
      data: doc2.content.update,
    } as unknown as VersionedSyncStep2Update);

    // Both contributions should be present (order depends on Y.js conflict resolution)
    const text = ydocD.getText("body").toString();
    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(text.length).toBe(10); // "hello" + "world"
  });

  it("createCompactedSidecar returns null for a single sidecar", async () => {
    const key = await createEncryptionKey();
    const client = new EncryptionClient({ document: "doc-1", key });
    const { encryptUpdate } = await import("teleportal/encryption-key");
    const { encodeSidecar } = await import("teleportal/protocol/encryption");

    const singleSidecar = await encryptUpdate(
      key,
      encodeSidecar({
        entries: [{ clientId: 1, clock: 0, contentRef: 4, data: new Uint8Array([1]) }],
        dictionary: new Map(),
      }),
    );

    const result = await client.createCompactedSidecar([singleSidecar], new Uint8Array(0));
    expect(result).toBeNull();
  });

  // ── Wrong-key rejection ───────────────────────────────────────────────────

  it("handleUpdate rejects when decrypting with a different key", async () => {
    const keyA = await createEncryptionKey();
    const keyB = await createEncryptionKey();

    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({ document: "doc-1", ydoc: ydocA, key: keyA });

    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({ document: "doc-1", ydoc: ydocB, key: keyB });

    ydocA.getText("body").insert(0, "secret content");
    const msg = await clientA.onUpdate({
      version: 2,
      data: Y.encodeStateAsUpdateV2(ydocA) as Update,
    } as VersionedUpdate);

    if (msg.type !== "doc" || msg.payload.type !== "update") {
      throw new Error("Expected doc update");
    }

    // Client B (wrong key) should throw, not silently produce garbage
    await expect(
      clientB.handleUpdate(msg.payload.update as unknown as VersionedUpdate),
    ).rejects.toThrow();

    // The Y.Doc should remain empty — no garbage applied
    expect(ydocB.getText("body").toString()).toBe("");
  });

  // ── Empty update handling ─────────────────────────────────────────────────

  it("handleUpdate with empty structure update does not crash", async () => {
    const key = await createEncryptionKey();
    const ydoc = new Y.Doc();
    const client = new EncryptionClient({ document: "doc-1", ydoc, key });

    // Encode an empty content-encrypted payload
    const emptyPayload = encodeContentEncryptedPayload({
      structureUpdate: new Uint8Array(0),
      encryptedSidecars: [],
    });

    await client.handleUpdate({
      version: 2,
      data: emptyPayload,
    } as unknown as VersionedUpdate);

    expect(ydoc.getText("body").toString()).toBe("");
  });

  // ── Incremental sidecar compaction ───────────────────────────────────────

  /**
   * Helper: create an encrypted VersionedUpdate from a Y.Doc edit.
   * Each call produces a distinct sidecar (different content).
   */
  async function makeEncryptedUpdate(key: CryptoKey, text: string): Promise<VersionedUpdate> {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, text);
    const update = Y.encodeStateAsUpdateV2(doc);
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, update, 2);
    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
    });
    return { version: 2, data: payload } as unknown as VersionedUpdate;
  }

  describe("incremental compaction", () => {
    const ORIGINAL_THRESHOLD = EncryptionClient.COMPACTION_THRESHOLD;

    // Use a low threshold for faster tests, restore afterward
    beforeEach(() => {
      EncryptionClient.COMPACTION_THRESHOLD = ORIGINAL_THRESHOLD;
    });

    it("triggers compaction after COMPACTION_THRESHOLD updates", async () => {
      const THRESHOLD = 5;
      EncryptionClient.COMPACTION_THRESHOLD = THRESHOLD;

      const key = await createEncryptionKey();
      const client = new EncryptionClient({ document: "doc-1", key });

      // Feed THRESHOLD updates
      for (let i = 0; i < THRESHOLD; i++) {
        const update = await makeEncryptedUpdate(key, `edit-${i}`);
        await client.handleUpdate(update);
      }

      // The next onUpdate should carry the compaction
      const ydoc = client.ydoc;
      ydoc.getText("notes").insert(0, "my own edit");
      const msg = await client.onUpdate({
        version: 2,
        data: Y.encodeStateAsUpdateV2(ydoc) as Update,
      } as VersionedUpdate);

      if (msg.type !== "doc" || msg.payload.type !== "update") {
        throw new Error("Expected doc update");
      }

      const decoded = decodeContentEncryptedPayload(msg.payload.update.data as Update);
      expect(decoded.compaction).toBeDefined();
      expect(decoded.compaction!.sourceHashes.length).toBe(THRESHOLD);
      expect(decoded.compaction!.sidecar).toBeInstanceOf(Uint8Array);
      expect(decoded.compaction!.hash).toBeInstanceOf(Uint8Array);
    });

    it("does not trigger compaction below threshold", async () => {
      const THRESHOLD = 10;
      EncryptionClient.COMPACTION_THRESHOLD = THRESHOLD;

      const key = await createEncryptionKey();
      const client = new EncryptionClient({ document: "doc-1", key });

      // Feed fewer than THRESHOLD updates
      for (let i = 0; i < THRESHOLD - 1; i++) {
        const update = await makeEncryptedUpdate(key, `edit-${i}`);
        await client.handleUpdate(update);
      }

      // onUpdate should NOT carry compaction
      const ydoc = client.ydoc;
      ydoc.getText("notes").insert(0, "my edit");
      const msg = await client.onUpdate({
        version: 2,
        data: Y.encodeStateAsUpdateV2(ydoc) as Update,
      } as VersionedUpdate);

      if (msg.type !== "doc" || msg.payload.type !== "update") {
        throw new Error("Expected doc update");
      }

      const decoded = decodeContentEncryptedPayload(msg.payload.update.data as Update);
      expect(decoded.compaction).toBeUndefined();
    });

    it("resets accumulator after compaction and triggers again", async () => {
      const THRESHOLD = 3;
      EncryptionClient.COMPACTION_THRESHOLD = THRESHOLD;

      const key = await createEncryptionKey();
      const client = new EncryptionClient({ document: "doc-1", key });

      // First batch: trigger compaction
      for (let i = 0; i < THRESHOLD; i++) {
        const update = await makeEncryptedUpdate(key, `batch1-${i}`);
        await client.handleUpdate(update);
      }

      // Consume the first compaction via onUpdate
      const ydoc = client.ydoc;
      ydoc.getText("notes").insert(0, "first send");
      const msg1 = await client.onUpdate({
        version: 2,
        data: Y.encodeStateAsUpdateV2(ydoc) as Update,
      } as VersionedUpdate);

      if (msg1.type !== "doc" || msg1.payload.type !== "update") {
        throw new Error("Expected doc update");
      }
      const decoded1 = decodeContentEncryptedPayload(msg1.payload.update.data as Update);
      expect(decoded1.compaction).toBeDefined();
      expect(decoded1.compaction!.sourceHashes.length).toBe(THRESHOLD);

      // Second batch: trigger compaction again
      for (let i = 0; i < THRESHOLD; i++) {
        const update = await makeEncryptedUpdate(key, `batch2-${i}`);
        await client.handleUpdate(update);
      }

      ydoc.getText("notes").insert(0, "second send");
      const msg2 = await client.onUpdate({
        version: 2,
        data: Y.encodeStateAsUpdateV2(ydoc) as Update,
      } as VersionedUpdate);

      if (msg2.type !== "doc" || msg2.payload.type !== "update") {
        throw new Error("Expected doc update");
      }
      const decoded2 = decodeContentEncryptedPayload(msg2.payload.update.data as Update);
      expect(decoded2.compaction).toBeDefined();
      expect(decoded2.compaction!.sourceHashes.length).toBe(THRESHOLD);
    });

    it("triggers compaction from outgoing updates only (single client)", async () => {
      const THRESHOLD = 4;
      EncryptionClient.COMPACTION_THRESHOLD = THRESHOLD;

      const key = await createEncryptionKey();
      const ydoc = new Y.Doc();
      const client = new EncryptionClient({ document: "doc-1", ydoc, key });

      // No handleUpdate — only the client's own edits via onUpdate
      for (let i = 0; i < THRESHOLD; i++) {
        ydoc.getText("body").insert(0, `edit-${i} `);
        await client.onUpdate({
          version: 2,
          data: Y.encodeStateAsUpdateV2(ydoc) as Update,
        } as VersionedUpdate);
      }

      // Compaction was triggered on the THRESHOLDth onUpdate but stored for the NEXT call.
      // The next onUpdate should carry it.
      ydoc.getText("body").insert(0, "trigger ");
      const msg = await client.onUpdate({
        version: 2,
        data: Y.encodeStateAsUpdateV2(ydoc) as Update,
      } as VersionedUpdate);

      if (msg.type !== "doc" || msg.payload.type !== "update") {
        throw new Error("Expected doc update");
      }

      const decoded = decodeContentEncryptedPayload(msg.payload.update.data as Update);
      expect(decoded.compaction).toBeDefined();
      expect(decoded.compaction!.sourceHashes.length).toBe(THRESHOLD);
    });

    it("onUpdate without pending compaction has no compaction field", async () => {
      const key = await createEncryptionKey();
      const ydoc = new Y.Doc();
      const client = new EncryptionClient({ document: "doc-1", ydoc, key });

      // No handleUpdate calls — no accumulated sidecars
      ydoc.getText("body").insert(0, "plain update");
      const msg = await client.onUpdate({
        version: 2,
        data: Y.encodeStateAsUpdateV2(ydoc) as Update,
      } as VersionedUpdate);

      if (msg.type !== "doc" || msg.payload.type !== "update") {
        throw new Error("Expected doc update");
      }

      const decoded = decodeContentEncryptedPayload(msg.payload.update.data as Update);
      expect(decoded.compaction).toBeUndefined();
    });
  });
});
