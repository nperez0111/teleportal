import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { getEmptyStateVector, type StateVector, type VersionedUpdate } from "teleportal";
import {
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
  type EncryptedUpdatePayload,
} from "../lib/protocol/encryption";
import { MemoryDocumentStorage } from "./in-memory/document-storage";

/**
 * Regression: when an update from a client is permanently lost (dropped burst
 * message from a session that never reconnects), the server's materialized
 * state contains Y.js Skip structs. Serving that gappy range in sync-step-2
 * parks the receiver's structs forever (`store.pendingStructs`), and the
 * provider's parked-structs watchdog then resyncs every 10s — an endless
 * sync-step-1/sync-step-2 loop, observed live in the file-system example.
 *
 * The server must clip what it serves at the first gap so receivers never
 * park, while reporting the honest (contiguous) state vector so a live sender
 * can still retransmit the missing range and heal the document.
 */

const DOC = "file-system";
const SENDER = 111;

/** N consecutive single-push updates from one client, as the wire envelope. */
const makeSenderUpdates = (n: number) => {
  const doc = new Y.Doc();
  doc.clientID = SENDER;
  const arr = doc.getArray("tree");
  const updates: Uint8Array[] = [];
  let prev = Y.encodeStateVector(doc);
  for (let i = 0; i < n; i++) {
    arr.push([`item-${i}`]);
    updates.push(Y.encodeStateAsUpdateV2(doc, prev));
    prev = Y.encodeStateVector(doc);
  }
  return { doc, updates };
};

const envelope = (structureUpdate: Uint8Array): VersionedUpdate =>
  ({
    version: 2,
    data: encodeContentEncryptedPayload({ structureUpdate, encryptedSidecars: [] }),
  }) as unknown as VersionedUpdate;

const applyServed = (update: unknown): Y.Doc => {
  const decoded = decodeContentEncryptedPayload(update as EncryptedUpdatePayload);
  const doc = new Y.Doc();
  if (decoded.structureUpdate.length > 0) {
    Y.applyUpdateV2(doc, decoded.structureUpdate);
  }
  return doc;
};

const pendingStructs = (doc: Y.Doc) => doc.store.pendingStructs;

describe("serving documents with lost-update gaps", () => {
  let storage: MemoryDocumentStorage;

  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    storage = new MemoryDocumentStorage(false);
  });

  const storeWithHoles = async () => {
    const { doc, updates } = makeSenderUpdates(10);
    // Clocks 3 and 5 never reach the server; everything else does.
    for (const i of [0, 1, 2, 4, 6, 7, 8, 9]) {
      await storage.handleUpdate(DOC, envelope(updates[i]!));
    }
    return { senderDoc: doc };
  };

  it("sync-step-1 response never parks the receiver and reports the honest state vector", async () => {
    await storeWithHoles();

    const served = await storage.handleSyncStep1(DOC, getEmptyStateVector());
    const receiver = applyServed(served.content.update);

    // The receiver integrates the served diff completely: nothing parked.
    expect(pendingStructs(receiver)).toBeNull();
    // Only the contiguous prefix (clocks 0-2) is servable.
    expect(receiver.getArray("tree").length).toBe(3);
    // The state vector must not claim the clipped tail, so a live sender's
    // next handshake retransmits from the first missing clock.
    const sv = Y.decodeStateVector(served.content.stateVector);
    expect(sv.get(SENDER)).toBe(3);
  });

  it("a receiver ahead of the gap gets a clean diff too", async () => {
    const { updates } = makeSenderUpdates(10);
    for (const i of [0, 1, 2, 4, 6, 7, 8, 9]) {
      await storage.handleUpdate(DOC, envelope(updates[i]!));
    }
    // Receiver already has clocks 0-2 (like the second browser in the repro).
    const upToDate = new Y.Doc();
    Y.applyUpdateV2(upToDate, Y.mergeUpdatesV2([updates[0]!, updates[1]!, updates[2]!]));

    const served = await storage.handleSyncStep1(
      DOC,
      Y.encodeStateVector(upToDate) as StateVector,
    );
    Y.applyUpdateV2(
      upToDate,
      decodeContentEncryptedPayload(served.content.update as EncryptedUpdatePayload)
        .structureUpdate,
    );
    expect(pendingStructs(upToDate)).toBeNull();
    expect(upToDate.getArray("tree").length).toBe(3);
  });

  it("the document heals once the sender retransmits against the served state vector", async () => {
    const { senderDoc } = await storeWithHoles();

    // The sender's handshake: server reports SV=3, sender sends the diff.
    const served = await storage.handleSyncStep1(DOC, getEmptyStateVector());
    const retransmit = Y.encodeStateAsUpdateV2(
      senderDoc,
      served.content.stateVector as unknown as Uint8Array,
    );
    await storage.handleUpdate(DOC, envelope(retransmit));

    const healed = await storage.handleSyncStep1(DOC, getEmptyStateVector());
    const receiver = applyServed(healed.content.update);
    expect(pendingStructs(receiver)).toBeNull();
    expect(receiver.getArray("tree").length).toBe(10);
    expect(Y.decodeStateVector(healed.content.stateVector).get(SENDER)).toBe(10);
  });

  it("gap-free documents are served byte-identically (no clipping overhead path)", async () => {
    const { updates } = makeSenderUpdates(5);
    for (const update of updates) {
      await storage.handleUpdate(DOC, envelope(update));
    }
    const served = await storage.handleSyncStep1(DOC, getEmptyStateVector());
    const receiver = applyServed(served.content.update);
    expect(pendingStructs(receiver)).toBeNull();
    expect(receiver.getArray("tree").length).toBe(5);
    expect(Y.decodeStateVector(served.content.stateVector).get(SENDER)).toBe(5);
  });
});
