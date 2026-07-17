import * as Y from "yjs";
import type { Update } from "teleportal";

/**
 * Calculates the size of a document update in bytes.
 *
 * @param update - The Y.js update as a Uint8Array
 * @returns The size of the update in bytes
 */
export function calculateDocumentSize(update: Update | null | undefined): number {
  if (!update) {
    return 0;
  }
  return update.length;
}

/**
 * Byte-wise equality check.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Clips a V2 update at lost-update gaps so it is always fully applicable.
 *
 * The pending log stores update blobs without integrating them, so if one
 * update in a client's sequence is permanently lost (dropped mid-burst by a
 * session that never reconnects), the materialized document contains Y.js
 * `Skip` structs. A receiver applying such an update integrates nothing past
 * the gap — Y.js silently parks the tail in `store.pendingStructs` — and the
 * provider's parked-structs watchdog then resyncs every 10s, forever, because
 * the server keeps serving the same unappliable range.
 *
 * Clipping drops each client's structs after its first gap. The clipped tail
 * stays in the pending log (this runs at serve time only), so a live sender
 * whose handshake sees the honest post-clip state vector retransmits the
 * missing range and fully heals the document. Only when no sender ever
 * returns is the tail unservable — and then it is unrecoverable anyway.
 *
 * Gap-free updates (the overwhelmingly common case) are returned as-is.
 */
export function clipUpdateAtGaps(update: Update): Update {
  const hasGap = Y.decodeUpdateV2(update).structs.some((struct) => struct instanceof Y.Skip);
  if (!hasGap) return update;
  // Integrate into a throwaway doc: Y.js applies everything reachable and
  // parks the post-gap tail. Dropping the parked remainder before re-encoding
  // yields the maximal appliable prefix. `gc: false` keeps deleted content
  // intact so the round-trip stays lossless for history-preserving storage.
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdateV2(doc, update);
  doc.store.pendingStructs = null;
  doc.store.pendingDs = null;
  const clipped = Y.encodeStateAsUpdateV2(doc) as Update;
  doc.destroy();
  return clipped;
}
