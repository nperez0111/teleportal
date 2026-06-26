import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createEncryptionKey, EncryptedBinary } from "teleportal/encryption-key";
import type { Update, VersionedUpdate } from "teleportal";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  encryptUpdateContent,
  decodeSidecar,
  restoreContent,
  mergeSidecars,
  stripContent,
  encodeSidecar,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { MemoryDocumentStorage } from "../in-memory/document-storage";

function makeContentEncryptedUpdate(v2Update: Uint8Array): EncryptedUpdatePayload {
  const { update: structureUpdate, sidecar } = stripContent(v2Update, 2);
  const sidecarBytes = encodeSidecar(sidecar);
  return encodeContentEncryptedPayload({
    structureUpdate,
    encryptedSidecars: [sidecarBytes as EncryptedBinary],
  }) as EncryptedUpdatePayload;
}

function envelopeUpdate(payload: Uint8Array): VersionedUpdate {
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

// ── Round-trip tests (in-memory backend, no IndexedDB) ──────────────────────

describe("IDB-like storage round-trip (via MemoryDocumentStorage)", () => {
  let storage: MemoryDocumentStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    storage = new MemoryDocumentStorage(true);
  });

  it("stores and retrieves a plaintext (fake-encrypted) document", async () => {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "hello world");
    const v2 = Y.encodeStateAsUpdateV2(doc);

    const payload = makeContentEncryptedUpdate(v2);
    await storage.handleUpdate("doc-1", envelopeUpdate(payload));

    const result = await storage.getDocument("doc-1");
    expect(result).not.toBeNull();

    const decoded = decodeContentEncryptedPayload(
      result!.content.update as unknown as EncryptedUpdatePayload,
    );
    const sidecars = decoded.encryptedSidecars.map((e) => decodeSidecar(e as Uint8Array));
    const restored = restoreContent(decoded.structureUpdate, mergeSidecars(sidecars));

    const reconstructed = new Y.Doc();
    Y.applyUpdateV2(reconstructed, restored);
    expect(reconstructed.getText("body").toString()).toBe("hello world");
  });

  it("round-trips a real encrypted document", async () => {
    const key = await createEncryptionKey();
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "encrypted content");
    const v2 = Y.encodeStateAsUpdateV2(doc);

    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, v2, 2);
    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
    });

    await storage.handleUpdate("doc-enc", envelopeUpdate(payload as EncryptedUpdatePayload));

    const result = await storage.getDocument("doc-enc");
    expect(result).not.toBeNull();

    const decoded = decodeContentEncryptedPayload(
      result!.content.update as unknown as EncryptedUpdatePayload,
    );
    expect(decoded.structureUpdate.length).toBeGreaterThan(0);
    expect(decoded.encryptedSidecars.length).toBe(1);

    const { decryptUpdate } = await import("teleportal/encryption-key");
    const sidecarBytes = await decryptUpdate(key, decoded.encryptedSidecars[0]);
    const sidecar = decodeSidecar(sidecarBytes);
    const restored = restoreContent(decoded.structureUpdate, mergeSidecars([sidecar]));

    const reconstructed = new Y.Doc();
    Y.applyUpdateV2(reconstructed, restored);
    expect(reconstructed.getText("body").toString()).toBe("encrypted content");
  });

  it("re-applied update converges to the same CRDT state", async () => {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "base");
    const v2 = Y.encodeStateAsUpdateV2(doc);
    const payload = makeContentEncryptedUpdate(v2);
    await storage.handleUpdate("doc-noop", envelopeUpdate(payload));

    const stateBefore = await storage.getDocument("doc-noop");

    // Re-send the same update. CRDT merge is idempotent so the state vector
    // does not advance; sidecars accumulate (compaction cleans them up).
    await storage.handleUpdate("doc-noop", envelopeUpdate(payload));
    const stateAfter = await storage.getDocument("doc-noop");

    expect(new Uint8Array(stateAfter!.content.stateVector)).toEqual(
      new Uint8Array(stateBefore!.content.stateVector),
    );
  });

  it("multiple incremental updates merge correctly", async () => {
    const doc = new Y.Doc();
    let prevSV = Y.encodeStateVectorFromUpdateV2(Y.encodeStateAsUpdateV2(doc));

    doc.getText("body").insert(0, "a");
    const v2a = Y.encodeStateAsUpdateV2(doc, prevSV);
    prevSV = Y.encodeStateVector(doc);
    await storage.handleUpdate("doc-inc", envelopeUpdate(makeContentEncryptedUpdate(v2a)));

    doc.getText("body").insert(1, "b");
    const v2b = Y.encodeStateAsUpdateV2(doc, prevSV);
    prevSV = Y.encodeStateVector(doc);
    await storage.handleUpdate("doc-inc", envelopeUpdate(makeContentEncryptedUpdate(v2b)));

    doc.getText("body").insert(2, "c");
    const v2c = Y.encodeStateAsUpdateV2(doc, prevSV);
    await storage.handleUpdate("doc-inc", envelopeUpdate(makeContentEncryptedUpdate(v2c)));

    const result = await storage.getDocument("doc-inc");
    const decoded = decodeContentEncryptedPayload(
      result!.content.update as unknown as EncryptedUpdatePayload,
    );
    const sidecars = decoded.encryptedSidecars.map((e) => decodeSidecar(e as Uint8Array));
    const restored = restoreContent(decoded.structureUpdate, mergeSidecars(sidecars));

    const reconstructed = new Y.Doc();
    Y.applyUpdateV2(reconstructed, restored);
    expect(reconstructed.getText("body").toString()).toBe("abc");
  });
});

// ── At-rest secrecy tests ───────────────────────────────────────────────────

describe("at-rest secrecy (encrypted vs plaintext)", () => {
  const MARKER = "SUPER_SECRET_MARKER_12345";

  it("encrypted content does not contain plaintext marker in stored state", async () => {
    const key = await createEncryptionKey();
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    const storage = new MemoryDocumentStorage(true);

    const doc = new Y.Doc();
    doc.getText("body").insert(0, MARKER);
    const v2 = Y.encodeStateAsUpdateV2(doc);

    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, v2, 2);
    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
    });
    await storage.handleUpdate("doc-secret", envelopeUpdate(payload as EncryptedUpdatePayload));

    const state = await (storage as any).getDocumentState("doc-secret");
    expect(state).not.toBeNull();

    const markerBytes = new TextEncoder().encode(MARKER);
    const updateStr = String.fromCharCode(...state!.update);
    expect(updateStr).not.toContain(MARKER);

    for (const s of state!.sidecars) {
      const sidecarStr = String.fromCharCode(...s.encrypted);
      expect(sidecarStr).not.toContain(MARKER);
    }

    // Additionally, search for the raw marker bytes in the binary.
    function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
      outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return true;
      }
      return false;
    }

    expect(containsSubsequence(state!.update, markerBytes)).toBe(false);
    for (const s of state!.sidecars) {
      expect(containsSubsequence(s.encrypted, markerBytes)).toBe(false);
    }
  });

  it("plaintext content DOES contain marker in stored state (expected exposure)", async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    const storage = new MemoryDocumentStorage(false);

    const doc = new Y.Doc();
    doc.getText("body").insert(0, MARKER);
    const v2 = Y.encodeStateAsUpdateV2(doc);
    const payload = makeContentEncryptedUpdate(v2);
    await storage.handleUpdate("doc-plain", envelopeUpdate(payload));

    const state = await (storage as any).getDocumentState("doc-plain");
    expect(state).not.toBeNull();

    // For plaintext, the "sidecars" are fake-encrypted (just encoded sidecar bytes).
    // The marker should be findable somewhere in the combined state.
    const markerBytes = new TextEncoder().encode(MARKER);

    function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
      outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return true;
      }
      return false;
    }

    const allBytes = new Uint8Array([
      ...state!.update,
      ...state!.sidecars.flatMap((s: any) => [...s.encrypted]),
    ]);
    expect(containsSubsequence(allBytes, markerBytes)).toBe(true);
  });
});
