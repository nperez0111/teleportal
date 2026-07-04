import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import type { EncryptedBinary } from "teleportal/encryption-key";
import type { IndexedSidecar, SidecarIndex } from "../../lib/protocol/encryption/content-cipher";
import type { SidecarCompaction } from "../../lib/protocol/encryption/encoding";
import type { PendingUpdate } from "../document-storage";

const CODEC_VERSION = 0;

function writeSidecarIndex(encoder: encoding.Encoder, index: SidecarIndex): void {
  encoding.writeVarUint(encoder, index.length);
  for (const range of index) {
    encoding.writeVarUint(encoder, range.clientId);
    encoding.writeVarUint(encoder, range.minClock);
    encoding.writeVarUint(encoder, range.maxClock);
  }
}

function readSidecarIndex(decoder: decoding.Decoder): SidecarIndex {
  const count = decoding.readVarUint(decoder);
  const index: SidecarIndex = [];
  for (let i = 0; i < count; i++) {
    index.push({
      clientId: decoding.readVarUint(decoder),
      minClock: decoding.readVarUint(decoder),
      maxClock: decoding.readVarUint(decoder),
    });
  }
  return index;
}

function writeIndexedSidecars(encoder: encoding.Encoder, sidecars: IndexedSidecar[]): void {
  encoding.writeVarUint(encoder, sidecars.length);
  for (const sidecar of sidecars) {
    encoding.writeVarUint8Array(encoder, sidecar.encrypted);
    writeSidecarIndex(encoder, sidecar.index);
    encoding.writeVarUint8Array(encoder, sidecar.hash);
  }
}

function readIndexedSidecars(decoder: decoding.Decoder): IndexedSidecar[] {
  const count = decoding.readVarUint(decoder);
  const sidecars: IndexedSidecar[] = [];
  for (let i = 0; i < count; i++) {
    const encrypted = decoding.readVarUint8Array(decoder) as EncryptedBinary;
    const index = readSidecarIndex(decoder);
    const hash = decoding.readVarUint8Array(decoder);
    sidecars.push({ encrypted, index, hash });
  }
  return sidecars;
}

/**
 * Encodes an {@link IndexedSidecar} list to binary for a `bytea` column.
 *
 * Wire format (v0):
 *   [version=0]
 *   [numSidecars as varUint]
 *   per sidecar:
 *     [encrypted as varUint8Array]
 *     [numIndexEntries as varUint]
 *     per entry: [clientId, minClock, maxClock as varUint]
 *     [hash as varUint8Array]
 */
export function encodeIndexedSidecars(sidecars: IndexedSidecar[]): Uint8Array {
  return encoding.encode((encoder) => {
    encoding.writeVarUint(encoder, CODEC_VERSION);
    writeIndexedSidecars(encoder, sidecars);
  });
}

export function decodeIndexedSidecars(data: Uint8Array): IndexedSidecar[] {
  try {
    const decoder = decoding.createDecoder(data);
    const version = decoding.readVarUint(decoder);
    if (version !== CODEC_VERSION) {
      throw new Error(`Unsupported sidecar codec version: ${version}`);
    }
    return readIndexedSidecars(decoder);
  } catch (e) {
    throw new Error("Failed to decode indexed sidecars", { cause: e });
  }
}

/**
 * Encodes a whole {@link PendingUpdate} to binary for a single `bytea` column.
 *
 * Wire format (v0):
 *   [version=0]
 *   [structureUpdate as varUint8Array]
 *   [indexed sidecars block — see {@link encodeIndexedSidecars} body]
 *   [hasCompaction as uint8]
 *   if hasCompaction == 1:
 *     [sidecar as varUint8Array]
 *     [index block]
 *     [hash as varUint8Array]
 *     [numSourceHashes as varUint]
 *     per sourceHash: [hash as varUint8Array]
 */
export function encodePendingUpdate(entry: PendingUpdate): Uint8Array {
  return encoding.encode((encoder) => {
    encoding.writeVarUint(encoder, CODEC_VERSION);
    encoding.writeVarUint8Array(encoder, entry.structureUpdate);
    writeIndexedSidecars(encoder, entry.sidecars);

    if (entry.compaction) {
      encoding.writeUint8(encoder, 1);
      encoding.writeVarUint8Array(encoder, entry.compaction.sidecar);
      writeSidecarIndex(encoder, entry.compaction.index);
      encoding.writeVarUint8Array(encoder, entry.compaction.hash);
      encoding.writeVarUint(encoder, entry.compaction.sourceHashes.length);
      for (const h of entry.compaction.sourceHashes) {
        encoding.writeVarUint8Array(encoder, h);
      }
    } else {
      encoding.writeUint8(encoder, 0);
    }
  });
}

export function decodePendingUpdate(data: Uint8Array): PendingUpdate {
  try {
    const decoder = decoding.createDecoder(data);
    const version = decoding.readVarUint(decoder);
    if (version !== CODEC_VERSION) {
      throw new Error(`Unsupported pending-update codec version: ${version}`);
    }
    const structureUpdate = decoding.readVarUint8Array(decoder);
    const sidecars = readIndexedSidecars(decoder);

    let compaction: SidecarCompaction | undefined;
    if (decoding.readUint8(decoder) === 1) {
      const sidecar = decoding.readVarUint8Array(decoder) as EncryptedBinary;
      const index = readSidecarIndex(decoder);
      const hash = decoding.readVarUint8Array(decoder);
      const numSourceHashes = decoding.readVarUint(decoder);
      const sourceHashes: Uint8Array[] = [];
      for (let i = 0; i < numSourceHashes; i++) {
        sourceHashes.push(decoding.readVarUint8Array(decoder));
      }
      compaction = { sidecar, index, hash, sourceHashes };
    }

    return { structureUpdate, sidecars, compaction };
  } catch (e) {
    throw new Error("Failed to decode pending update", { cause: e });
  }
}
