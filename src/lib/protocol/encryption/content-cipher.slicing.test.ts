import { describe, expect, it } from "bun:test";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import {
  buildSidecarIndex,
  restoreContent,
  sidecarOverlapsDiff,
  stripContent,
} from "./content-cipher";

/**
 * Regression tests for content items that Y.diffUpdateV2 slices mid-item.
 *
 * When a peer already holds a prefix of a long single-author content item
 * (string / JSON / any), the server's diff (Y.diffUpdateV2) returns that item
 * sliced at the peer's clock — the struct's id.clock is then an offset INTO the
 * original item, not its start. Sidecar entries are keyed by the item's start
 * clock, so restoreContent must locate the entry whose range contains the
 * sliced clock and sub-slice its content by the offset.
 */
describe("restoreContent with content sliced mid-item by diffUpdateV2", () => {
  // A Y.js state vector is { numClients, [clientId, clock]... }.
  function stateVector(clientId: number, clock: number): Uint8Array {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint(enc, clientId);
    encoding.writeVarUint(enc, clock);
    return encoding.toUint8Array(enc);
  }

  it("restores a string item sliced at a non-zero offset", () => {
    const clientId = 4242;

    // One client inserts a single 10-char string => one item at clocks 0-9.
    const doc1 = new Y.Doc();
    doc1.clientID = clientId;
    doc1.getText("t").insert(0, "HelloWorld");
    const full = Y.encodeStateAsUpdateV2(doc1);

    const { update: structureUpdate, sidecar } = stripContent(full, 2);

    // A peer that already holds "Hello" (clocks 0-4). The server's diff slices
    // the single item at clock 5, producing a struct whose clock is 5.
    const peerSv = stateVector(clientId, 5);
    const structDiff = Y.diffUpdateV2(structureUpdate, peerSv);

    // restoreContent must not throw and must reproduce the original "World" tail.
    const restored = restoreContent(structDiff, sidecar, 2);

    // Seed a doc with the "Hello" prefix (same client, clocks 0-4) so the
    // sliced tail integrates, then apply the restored tail.
    const prefixDoc = new Y.Doc();
    prefixDoc.clientID = clientId;
    prefixDoc.getText("t").insert(0, "Hello");
    const out = new Y.Doc();
    Y.applyUpdateV2(out, Y.encodeStateAsUpdateV2(prefixDoc));
    Y.applyUpdateV2(out, restored);

    expect(out.getText("t").toString()).toBe("HelloWorld");
  });

  it("buildSidecarIndex covers the full clock range of a multi-clock item", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "HelloWorld");
    const { sidecar } = stripContent(Y.encodeStateAsUpdateV2(doc), 2);

    const index = buildSidecarIndex(sidecar.entries);
    const clientId = doc.clientID;
    const range = index.find((r) => r.clientId === clientId)!;
    expect(range).toBeDefined();

    // The 10-char item spans clocks 0-9; the index must reflect that so the
    // server doesn't filter the sidecar out for a tail diff.
    expect(range.maxClock).toBe(9);

    // A diff over clocks 5-9 must be considered overlapping.
    const overlaps = sidecarOverlapsDiff(index, {
      from: new Map([[clientId, 5]]),
      to: new Map([[clientId, 10]]),
    });
    expect(overlaps).toBe(true);
  });
});
