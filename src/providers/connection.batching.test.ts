import { describe, expect, it, beforeEach } from "bun:test";
import * as Y from "yjs";
import { Connection } from "./connection";
import { createMemoryTransportPair, type MemoryTransportHandle } from "./transports/memory";
import { DocMessage } from "teleportal";
import type { VersionedUpdate } from "teleportal/protocol";
import {
  mergeContentEncryptedPayloads,
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
  encryptToContentPayload,
  decryptContentPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { createEncryptionKey } from "teleportal/encryption-key";
import type { Timer } from "./utils";

// ---------------------------------------------------------------------------
// FakeTimer (mirrors connection.test.ts harness for deterministic batching)
// ---------------------------------------------------------------------------

class FakeTimer implements Timer {
  private timeouts: Map<number, { callback: () => void; fireAt: number }> = new Map();
  private intervals: Map<number, { callback: () => void; interval: number; nextFire: number }> =
    new Map();
  private nextId = 1;
  public now = 0;

  setTimeout(callback: () => void, delay: number) {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, fireAt: this.now + delay });
    return id as any;
  }
  setInterval(callback: () => void, interval: number) {
    const id = this.nextId++;
    this.intervals.set(id, { callback, interval, nextFire: this.now + interval });
    return id as any;
  }
  clearTimeout(id: any) {
    this.timeouts.delete(id);
  }
  clearInterval(id: any) {
    this.intervals.delete(id);
  }

  async advance(ms: number) {
    const target = this.now + ms;
    while (this.now < target) {
      let nextTime = target;
      for (const [, t] of this.timeouts) {
        if (t.fireAt < nextTime) nextTime = t.fireAt;
      }
      for (const [, i] of this.intervals) {
        if (i.nextFire < nextTime) nextTime = i.nextFire;
      }
      this.now = nextTime;
      for (const [id, t] of this.timeouts) {
        if (t.fireAt <= this.now) {
          this.timeouts.delete(id);
          t.callback();
        }
      }
      for (const [id, i] of this.intervals) {
        if (i.nextFire <= this.now && this.intervals.has(id)) {
          i.nextFire += i.interval;
          i.callback();
        }
      }
      await new Promise<void>((r) => queueMicrotask(r));
    }
  }
}

async function flushMicrotasks(count = 5) {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((r) => queueMicrotask(r));
  }
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/**
 * Build a content-encrypted payload from a sequence of text inserts on a
 * single doc. Each call uses the SAME clientId/doc so that the resulting
 * V2 structure updates form a clean causal chain that Y.mergeUpdatesV2 (and
 * applying individually) can reconstruct identically.
 */
async function buildEncryptedPayload(
  key: CryptoKey,
  doc: Y.Doc,
  insert: () => void,
): Promise<{ payload: EncryptedUpdatePayload; v2Update: Uint8Array }> {
  return await new Promise((resolve) => {
    doc.once("updateV2", (update: Uint8Array) => {
      encryptToContentPayload(key, update).then((payload) => {
        resolve({ payload: payload as EncryptedUpdatePayload, v2Update: update });
      });
    });
    insert();
  });
}

/** Build a plain (unencrypted, empty-sidecar) content-encrypted payload. */
function plainPayload(structureUpdate: Uint8Array): EncryptedUpdatePayload {
  return encodeContentEncryptedPayload({
    structureUpdate,
    encryptedSidecars: [],
  });
}

function makeEncDocUpdate(
  docName: string,
  payload: EncryptedUpdatePayload,
  encrypted = true,
): DocMessage<any> {
  return new DocMessage(
    docName,
    { type: "update", update: { version: 2, data: payload } as unknown as VersionedUpdate },
    {},
    encrypted,
  );
}

// ---------------------------------------------------------------------------
// Direct mergeContentEncryptedPayloads tests
// ---------------------------------------------------------------------------

describe("mergeContentEncryptedPayloads (direct)", () => {
  it("merges multiple content-encrypted payloads: structureUpdate equals Y.mergeUpdatesV2 of parts and sidecars concat in order", async () => {
    const key = await createEncryptionKey();
    const doc = new Y.Doc();
    const text = doc.getText("t");

    const a = await buildEncryptedPayload(key, doc, () => text.insert(0, "hello "));
    const b = await buildEncryptedPayload(key, doc, () => text.insert(6, "world "));
    const c = await buildEncryptedPayload(key, doc, () => text.insert(12, "again"));

    const decodedParts = [a, b, c].map((p) => decodeContentEncryptedPayload(p.payload));
    const merged = mergeContentEncryptedPayloads([a.payload, b.payload, c.payload]);
    const decodedMerged = decodeContentEncryptedPayload(merged);

    // structureUpdate equals Y.mergeUpdatesV2 of the parts' structure updates
    const expectedStructure = Y.mergeUpdatesV2(decodedParts.map((d) => d.structureUpdate));
    expect(decodedMerged.structureUpdate).toEqual(expectedStructure);

    // encryptedSidecars are the concatenation of all parts' sidecars, order preserved
    const expectedSidecars = decodedParts.flatMap((d) => d.encryptedSidecars);
    expect(decodedMerged.encryptedSidecars.length).toBe(expectedSidecars.length);
    for (let i = 0; i < expectedSidecars.length; i++) {
      expect(decodedMerged.encryptedSidecars[i]).toEqual(expectedSidecars[i]);
    }
    // each part contributed exactly one sidecar
    expect(decodedMerged.encryptedSidecars.length).toBe(3);
  });

  it("returns a single payload unchanged (same reference, no re-encode)", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "solo");
    const only = plainPayload(Y.encodeStateAsUpdateV2(doc));

    const merged = mergeContentEncryptedPayloads([only]);
    // Must be the exact same object reference - proves no needless re-encode.
    expect(merged).toBe(only);
  });

  it("returns an empty payload for an empty input array", () => {
    const merged = mergeContentEncryptedPayloads([]);
    const decoded = decodeContentEncryptedPayload(merged);
    expect(decoded.structureUpdate.length).toBe(0);
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  it("decrypting the merged payload reconstructs the same combined Y.Doc state as applying parts individually", async () => {
    const key = await createEncryptionKey();

    // Author doc: three sequential edits
    const author = new Y.Doc();
    const text = author.getText("t");
    const a = await buildEncryptedPayload(key, author, () => text.insert(0, "Lorem "));
    const b = await buildEncryptedPayload(key, author, () => text.insert(6, "ipsum "));
    const c = await buildEncryptedPayload(key, author, () => text.insert(12, "dolor"));

    // Reference: apply the original cleartext V2 updates individually.
    const refDoc = new Y.Doc();
    Y.applyUpdateV2(refDoc, a.v2Update);
    Y.applyUpdateV2(refDoc, b.v2Update);
    Y.applyUpdateV2(refDoc, c.v2Update);

    // Merge encrypted payloads, then decrypt back to a cleartext update.
    const merged = mergeContentEncryptedPayloads([a.payload, b.payload, c.payload]);
    const decoded = decodeContentEncryptedPayload(merged);
    const cleartext = await decryptContentPayload(
      key,
      decoded.structureUpdate,
      decoded.encryptedSidecars,
    );

    const mergedDoc = new Y.Doc();
    Y.applyUpdateV2(mergedDoc, cleartext);

    expect(mergedDoc.getText("t").toString()).toBe("Lorem ipsum dolor");
    expect(mergedDoc.getText("t").toString()).toBe(refDoc.getText("t").toString());
    // Full state vectors match => identical CRDT state, not just identical text.
    expect(Y.encodeStateVector(mergedDoc)).toEqual(Y.encodeStateVector(refDoc));
  });

  it("preserves sidecar order across payloads carrying multiple sidecars each", async () => {
    const key = await createEncryptionKey();
    const doc = new Y.Doc();
    const text = doc.getText("t");

    const a = await buildEncryptedPayload(key, doc, () => text.insert(0, "A"));
    const b = await buildEncryptedPayload(key, doc, () => text.insert(1, "B"));

    // First payload pre-merged to carry 2 sidecars, second carries 1.
    const firstWithTwo = mergeContentEncryptedPayloads([a.payload, b.payload]);
    const c = await buildEncryptedPayload(key, doc, () => text.insert(2, "C"));

    const decodedFirst = decodeContentEncryptedPayload(firstWithTwo);
    const decodedC = decodeContentEncryptedPayload(c.payload);
    expect(decodedFirst.encryptedSidecars.length).toBe(2);

    const merged = mergeContentEncryptedPayloads([firstWithTwo, c.payload]);
    const decodedMerged = decodeContentEncryptedPayload(merged);

    const expectedOrder = [...decodedFirst.encryptedSidecars, ...decodedC.encryptedSidecars];
    expect(decodedMerged.encryptedSidecars.length).toBe(3);
    for (let i = 0; i < expectedOrder.length; i++) {
      expect(decodedMerged.encryptedSidecars[i]).toEqual(expectedOrder[i]);
    }

    // And it still decrypts to the full "ABC".
    const cleartext = await decryptContentPayload(
      key,
      decodedMerged.structureUpdate,
      decodedMerged.encryptedSidecars,
    );
    const out = new Y.Doc();
    Y.applyUpdateV2(out, cleartext);
    expect(out.getText("t").toString()).toBe("ABC");
  });

  // ── EDGE CASE: zero-length structureUpdate payloads ──────────────────────
  //
  // getEmptyContentEncryptedPayload() (encoding.ts) emits a zero-length
  // structureUpdate, and document-storage.ts uses it as a real update for empty
  // docs. mergeContentEncryptedPayloads must therefore tolerate a zero-length
  // structureUpdate interspersed in the batch: Y.mergeUpdatesV2 cannot parse a
  // zero-byte V2 update, so empty structure updates are dropped before merging
  // while their (absent) sidecars contribute nothing. A *real* empty V2 update
  // is 13 bytes (Y.encodeStateAsUpdateV2(new Y.Doc())), not zero-length.

  it("drops a zero-length structureUpdate interspersed in the batch and merges the rest", async () => {
    const key = await createEncryptionKey();
    const doc = new Y.Doc();
    const real = await buildEncryptedPayload(key, doc, () => doc.getText("t").insert(0, "data"));
    const empty1 = plainPayload(new Uint8Array(0));
    const empty2 = plainPayload(new Uint8Array(0));

    const merged = mergeContentEncryptedPayloads([empty1, real.payload, empty2]);
    const decoded = decodeContentEncryptedPayload(merged);
    expect(decoded.encryptedSidecars.length).toBe(1);

    const cleartext = await decryptContentPayload(
      key,
      decoded.structureUpdate,
      decoded.encryptedSidecars,
    );
    const out = new Y.Doc();
    Y.applyUpdateV2(out, cleartext);
    expect(out.getText("t").toString()).toBe("data");
  });

  it("returns an empty structureUpdate when merging two all-empty payloads", () => {
    const empty1 = plainPayload(new Uint8Array(0));
    const empty2 = plainPayload(new Uint8Array(0));
    const merged = mergeContentEncryptedPayloads([empty1, empty2]);
    const decoded = decodeContentEncryptedPayload(merged);
    expect(decoded.structureUpdate.length).toBe(0);
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  it("merging a real EMPTY-DOC V2 update (13 bytes, not zero-length) is a no-op and does not throw", async () => {
    const key = await createEncryptionKey();
    // A genuinely empty Y.Doc still encodes to a non-empty V2 update.
    const realEmptyDocUpdate = Y.encodeStateAsUpdateV2(new Y.Doc());
    expect(realEmptyDocUpdate.length).toBeGreaterThan(0);
    const emptyDocPayload = plainPayload(realEmptyDocUpdate);

    const doc = new Y.Doc();
    const real = await buildEncryptedPayload(key, doc, () => doc.getText("t").insert(0, "data"));

    // This form (non-zero-length structure) merges cleanly.
    const merged = mergeContentEncryptedPayloads([emptyDocPayload, real.payload]);
    const decoded = decodeContentEncryptedPayload(merged);
    expect(decoded.encryptedSidecars.length).toBe(1);

    const cleartext = await decryptContentPayload(
      key,
      decoded.structureUpdate,
      decoded.encryptedSidecars,
    );
    const out = new Y.Doc();
    Y.applyUpdateV2(out, cleartext);
    expect(out.getText("t").toString()).toBe("data");
  });
});

// ---------------------------------------------------------------------------
// Connection-level batching of content-encrypted payloads
// ---------------------------------------------------------------------------

describe("Connection batching of content-encrypted payloads", () => {
  let clientTransport: MemoryTransportHandle;

  beforeEach(() => {
    [clientTransport] = createMemoryTransportPair();
  });

  it("merges multiple buffered encrypted updates for one doc into ONE wire message that decrypts to the combined state", async () => {
    const key = await createEncryptionKey();
    const author = new Y.Doc();
    const text = author.getText("t");
    const a = await buildEncryptedPayload(key, author, () => text.insert(0, "foo "));
    const b = await buildEncryptedPayload(key, author, () => text.insert(4, "bar "));
    const c = await buildEncryptedPayload(key, author, () => text.insert(8, "baz"));

    const timer = new FakeTimer();
    const conn = new Connection({
      transports: [clientTransport],
      connect: false,
      batchIntervalMs: 50,
      timer,
    });
    await timer.advance(0);
    await conn.connect();

    await conn.send(makeEncDocUpdate("doc-enc", a.payload));
    await conn.send(makeEncDocUpdate("doc-enc", b.payload));
    await conn.send(makeEncDocUpdate("doc-enc", c.payload));

    await timer.advance(60);
    await flushMicrotasks(10);

    const docMessages = clientTransport.sentMessages.filter(
      (m) => m.type === "doc" && (m.payload as any).type === "update",
    ) as DocMessage<any>[];
    // Exactly one merged message on the wire.
    expect(docMessages.length).toBe(1);

    const wirePayload = (docMessages[0].payload as { update: VersionedUpdate }).update
      .data as EncryptedUpdatePayload;
    const decoded = decodeContentEncryptedPayload(wirePayload);
    expect(decoded.encryptedSidecars.length).toBe(3);

    const cleartext = await decryptContentPayload(
      key,
      decoded.structureUpdate,
      decoded.encryptedSidecars,
    );
    const out = new Y.Doc();
    Y.applyUpdateV2(out, cleartext);
    expect(out.getText("t").toString()).toBe("foo bar baz");

    await conn.destroy();
  });

  it("sends a single buffered encrypted update unchanged (identical payload bytes, no re-encode)", async () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "solo-update");
    const payload = plainPayload(Y.encodeStateAsUpdateV2(doc));

    const timer = new FakeTimer();
    const conn = new Connection({
      transports: [clientTransport],
      connect: false,
      batchIntervalMs: 50,
      timer,
    });
    await timer.advance(0);
    await conn.connect();

    await conn.send(makeEncDocUpdate("doc-single", payload));

    await timer.advance(60);
    await flushMicrotasks(10);

    const docMessages = clientTransport.sentMessages.filter(
      (m) => m.type === "doc" && (m.payload as any).type === "update",
    ) as DocMessage<any>[];
    expect(docMessages.length).toBe(1);

    // The single-update path returns the original message object: the payload
    // bytes must be byte-identical to what we sent (no re-encode round trip).
    const wirePayload = (docMessages[0].payload as { update: VersionedUpdate }).update
      .data as EncryptedUpdatePayload;
    expect(wirePayload).toEqual(payload);

    await conn.destroy();
  });

  it("does NOT merge updates for different documents", async () => {
    const key = await createEncryptionKey();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = await buildEncryptedPayload(key, docA, () => docA.getText("t").insert(0, "AAA"));
    const b = await buildEncryptedPayload(key, docB, () => docB.getText("t").insert(0, "BBB"));

    const timer = new FakeTimer();
    const conn = new Connection({
      transports: [clientTransport],
      connect: false,
      batchIntervalMs: 50,
      timer,
    });
    await timer.advance(0);
    await conn.connect();

    await conn.send(makeEncDocUpdate("doc-a", a.payload));
    await conn.send(makeEncDocUpdate("doc-b", b.payload));

    await timer.advance(60);
    await flushMicrotasks(10);

    const docMessages = clientTransport.sentMessages.filter(
      (m) => m.type === "doc" && (m.payload as any).type === "update",
    ) as DocMessage<any>[];
    // Two distinct docs => two messages, not merged into one.
    expect(docMessages.length).toBe(2);
    const docNames = docMessages.map((m) => m.document).sort();
    expect(docNames).toEqual(["doc-a", "doc-b"]);

    await conn.destroy();
  });

  it("does NOT batch/merge non doc-update messages (sync-step / non-update doc payloads pass through)", async () => {
    const timer = new FakeTimer();
    const conn = new Connection({
      transports: [clientTransport],
      connect: false,
      batchIntervalMs: 50,
      timer,
    });
    await timer.advance(0);
    await conn.connect();

    // A doc message whose payload is NOT type "update" must not be batched
    // (it should be sent immediately, bypassing the pending-updates map).
    const nonUpdate = new DocMessage(
      "doc-x",
      { type: "sync-step-1", sv: new Uint8Array([0]) } as any,
      {},
      false,
    );
    await conn.send(nonUpdate);

    // No batch flush has fired yet, but a non-batchable message is sent right away.
    const before = clientTransport.sentMessages.filter((m) => m.type === "doc").length;
    expect(before).toBe(1);

    await conn.destroy();
  });

  it("buffer-side merge: encrypted updates buffered while disconnected merge into one, sent on reconnect, decrypting to combined state", async () => {
    const key = await createEncryptionKey();
    const author = new Y.Doc();
    const text = author.getText("t");
    const a = await buildEncryptedPayload(key, author, () => text.insert(0, "x"));
    const b = await buildEncryptedPayload(key, author, () => text.insert(1, "y"));
    const c = await buildEncryptedPayload(key, author, () => text.insert(2, "z"));

    // batchIntervalMs: 0 disables the AIMD batcher, so sends while disconnected
    // go straight to #bufferMessage, which performs its own buffer-side merge.
    const conn = new Connection({
      transports: [clientTransport],
      connect: false,
      batchIntervalMs: 0,
    });

    // Not connected yet -> buffered + merged in the buffer.
    await conn.send(makeEncDocUpdate("doc-buf", a.payload));
    await conn.send(makeEncDocUpdate("doc-buf", b.payload));
    await conn.send(makeEncDocUpdate("doc-buf", c.payload));

    expect(clientTransport.sentMessages).toHaveLength(0);

    await conn.connect();
    await flushMicrotasks(10);

    const docMessages = clientTransport.sentMessages.filter(
      (m) => m.type === "doc" && (m.payload as any).type === "update",
    ) as DocMessage<any>[];
    expect(docMessages.length).toBe(1);

    const wirePayload = (docMessages[0].payload as { update: VersionedUpdate }).update
      .data as EncryptedUpdatePayload;
    const decoded = decodeContentEncryptedPayload(wirePayload);
    expect(decoded.encryptedSidecars.length).toBe(3);

    const cleartext = await decryptContentPayload(
      key,
      decoded.structureUpdate,
      decoded.encryptedSidecars,
    );
    const out = new Y.Doc();
    Y.applyUpdateV2(out, cleartext);
    expect(out.getText("t").toString()).toBe("xyz");

    await conn.destroy();
  });
});
