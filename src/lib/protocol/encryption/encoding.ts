import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import type { Update } from "teleportal";
import { EncryptedBinary } from "teleportal/encryption-key";
import type { SidecarIndex } from "./content-cipher";

/**
 * Compaction data piggy-backed on a content-encrypted payload.
 * Carries the compacted sidecar and the hashes of the source sidecars
 * it was built from, so the server can match and replace them.
 */
export type SidecarCompaction = {
  sidecar: EncryptedBinary;
  index: SidecarIndex;
  hash: Uint8Array;
  sourceHashes: Uint8Array[];
};

/**
 * A content-encrypted update payload. The structure update is a valid Y.js V2
 * update with placeholder content (CRDT metadata intact). The encrypted
 * sidecars contain the original content encrypted with AES-256-GCM.
 */
export type ContentEncryptedPayload = {
  wireVersion?: number;
  structureUpdate: Uint8Array;
  encryptedSidecars: EncryptedBinary[];
  compaction?: SidecarCompaction;
};

/**
 * The binary (wire) representation of a {@link ContentEncryptedPayload}.
 * Opaque to anything that does not hold the encryption key.
 */
export type EncryptedUpdatePayload = Update;

/**
 * A versioned wrapper for encrypted updates, ensuring encrypted and cleartext
 * updates cannot be confused at the type level.
 */
export type EncryptedVersionedUpdate =
  | { version: 1; data: EncryptedUpdatePayload }
  | { version: 2; data: EncryptedUpdatePayload };

const CONTENT_ENCRYPTED_VERSION = 1;

/**
 * Encodes a {@link ContentEncryptedPayload} to binary.
 *
 * Wire format (v1):
 *   [version=1]
 *   [structureUpdate as varUint8Array]
 *   [numSidecars as varUint]
 *   per sidecar: [sidecar as varUint8Array]
 *   [hasCompaction as uint8]
 *   if hasCompaction == 1:
 *     [compactedSidecar as varUint8Array]
 *     [numIndexEntries as varUint]
 *     per entry: [clientId as varUint, minClock as varUint, maxClock as varUint]
 *     [compactedHash as varUint8Array]
 *     [numSourceHashes as varUint]
 *     per sourceHash: [hash as varUint8Array]
 */
export function encodeContentEncryptedPayload(
  payload: ContentEncryptedPayload,
): EncryptedUpdatePayload {
  return encoding.encode((encoder) => {
    encoding.writeVarUint(encoder, CONTENT_ENCRYPTED_VERSION);
    encoding.writeVarUint8Array(encoder, payload.structureUpdate);
    encoding.writeVarUint(encoder, payload.encryptedSidecars.length);
    for (const sidecar of payload.encryptedSidecars) {
      encoding.writeVarUint8Array(encoder, sidecar);
    }

    if (payload.compaction) {
      encoding.writeUint8(encoder, 1);
      encoding.writeVarUint8Array(encoder, payload.compaction.sidecar);
      encoding.writeVarUint(encoder, payload.compaction.index.length);
      for (const entry of payload.compaction.index) {
        encoding.writeVarUint(encoder, entry.clientId);
        encoding.writeVarUint(encoder, entry.minClock);
        encoding.writeVarUint(encoder, entry.maxClock);
      }
      encoding.writeVarUint8Array(encoder, payload.compaction.hash);
      encoding.writeVarUint(encoder, payload.compaction.sourceHashes.length);
      for (const h of payload.compaction.sourceHashes) {
        encoding.writeVarUint8Array(encoder, h);
      }
    } else {
      encoding.writeUint8(encoder, 0);
    }
  }) as EncryptedUpdatePayload;
}

/**
 * Decodes binary into a {@link ContentEncryptedPayload}.
 */
export function decodeContentEncryptedPayload(
  data: EncryptedUpdatePayload,
): ContentEncryptedPayload {
  try {
    const decoder = decoding.createDecoder(data);
    const version = decoding.readVarUint(decoder);
    if (version !== CONTENT_ENCRYPTED_VERSION) {
      throw new Error(`Unsupported content-encrypted version: ${version}`);
    }
    const structureUpdate = decoding.readVarUint8Array(decoder);
    const numSidecars = decoding.readVarUint(decoder);
    const encryptedSidecars: EncryptedBinary[] = [];
    for (let i = 0; i < numSidecars; i++) {
      encryptedSidecars.push(decoding.readVarUint8Array(decoder) as EncryptedBinary);
    }

    let compaction: SidecarCompaction | undefined;
    if (decoder.pos < data.length) {
      const hasCompaction = decoding.readUint8(decoder);
      if (hasCompaction === 1) {
        const sidecar = decoding.readVarUint8Array(decoder) as EncryptedBinary;
        const numIndexEntries = decoding.readVarUint(decoder);
        const index: SidecarIndex = [];
        for (let i = 0; i < numIndexEntries; i++) {
          index.push({
            clientId: decoding.readVarUint(decoder),
            minClock: decoding.readVarUint(decoder),
            maxClock: decoding.readVarUint(decoder),
          });
        }
        const hash = decoding.readVarUint8Array(decoder);
        const numSourceHashes = decoding.readVarUint(decoder);
        const sourceHashes: Uint8Array[] = [];
        for (let i = 0; i < numSourceHashes; i++) {
          sourceHashes.push(decoding.readVarUint8Array(decoder));
        }
        compaction = { sidecar, index, hash, sourceHashes };
      }
    }

    return { wireVersion: version, structureUpdate, encryptedSidecars, compaction };
  } catch (e) {
    throw new Error("Failed to decode content-encrypted payload", { cause: e });
  }
}

export function getEmptyContentEncryptedPayload(): EncryptedUpdatePayload {
  return encodeContentEncryptedPayload({
    structureUpdate: new Uint8Array(0),
    encryptedSidecars: [],
  });
}

export function isEmptyContentEncryptedPayload(payload: EncryptedUpdatePayload): boolean {
  try {
    const decoded = decodeContentEncryptedPayload(payload);
    return decoded.structureUpdate.length === 0 && decoded.encryptedSidecars.length === 0;
  } catch {
    return false;
  }
}

/**
 * Merges multiple {@link EncryptedUpdatePayload}s into a single payload.
 * Structure updates are merged via `Y.mergeUpdatesV2` (empty structures are
 * dropped to avoid tripping the Y.js parser). Encrypted sidecars are
 * concatenated. At most one {@link SidecarCompaction} is preserved (the first
 * found); the rest will re-compact on a later round.
 */
export function mergeContentEncryptedPayloads(
  payloads: EncryptedUpdatePayload[],
): EncryptedUpdatePayload {
  if (payloads.length === 0) return getEmptyContentEncryptedPayload();
  if (payloads.length === 1) return payloads[0];

  const decoded = payloads.map(decodeContentEncryptedPayload);
  // Y.mergeUpdatesV2 cannot parse a zero-length update (the form produced by
  // getEmptyContentEncryptedPayload), so drop empty structure updates before
  // merging. Sidecars are preserved regardless of structure-update length.
  const structures = decoded.map((d) => d.structureUpdate).filter((u) => u.length > 0);
  const mergedStructure =
    structures.length === 0 ? new Uint8Array(0) : Y.mergeUpdatesV2(structures);
  const allSidecars = decoded.flatMap((d) => d.encryptedSidecars);

  // Preserve a piggy-backed compaction through the merge. A compaction's
  // sourceHashes reference already-stored server sidecars, so it stays valid
  // regardless of which structure updates are merged with it. Dropping it (the
  // previous behavior) silently lost the compaction since the producer already
  // cleared its pending state, leaving superseded sidecars uncollapsed. The
  // payload format holds a single compaction; merging two is vanishingly rare,
  // so keep the first and let the rest re-compact on a later round.
  const compaction = decoded.find((d) => d.compaction)?.compaction;

  return encodeContentEncryptedPayload({
    structureUpdate: mergedStructure,
    encryptedSidecars: allSidecars,
    compaction,
  });
}
