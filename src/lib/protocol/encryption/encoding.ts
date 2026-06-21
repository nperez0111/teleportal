import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import type { Update } from "teleportal";
import { EncryptedBinary } from "teleportal/encryption-key";

/**
 * A content-encrypted update payload. The structure update is a valid Y.js V1
 * update with placeholder content (CRDT metadata intact). The encrypted
 * sidecars contain the original content encrypted with AES-256-GCM.
 */
export type ContentEncryptedPayload = {
  structureUpdate: Uint8Array;
  encryptedSidecars: EncryptedBinary[];
};

export type EncryptedUpdatePayload = Update;

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
    return { structureUpdate, encryptedSidecars };
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

export function mergeContentEncryptedPayloads(
  payloads: EncryptedUpdatePayload[],
): EncryptedUpdatePayload {
  if (payloads.length === 0) return getEmptyContentEncryptedPayload();
  if (payloads.length === 1) return payloads[0];

  const decoded = payloads.map(decodeContentEncryptedPayload);
  const mergedStructure = Y.mergeUpdates(decoded.map((d) => d.structureUpdate));
  const allSidecars = decoded.flatMap((d) => d.encryptedSidecars);

  return encodeContentEncryptedPayload({
    structureUpdate: mergedStructure,
    encryptedSidecars: allSidecars,
  });
}
