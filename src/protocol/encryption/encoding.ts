import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import type { StateVector, Update } from "teleportal";
import { toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";

export type DecodedFauxStateVector = {
  messageIds: string[];
};

export type FauxStateVector = StateVector;
export type FauxUpdate = Update;

/**
 * Converts a message ID (base64 hash) to a compact numeric representation
 * by taking the first 8 bytes of the hash and converting to a bigint
 */
export function messageIdToNumber(messageId: string): bigint {
  const buffer = new Uint8Array(8);
  const decoded = Uint8Array.from(atob(messageId), c => c.charCodeAt(0));
  buffer.set(decoded.slice(0, 8));
  return new DataView(buffer.buffer).getBigUint64(0, false);
}

/**
 * Converts a numeric representation back to a message ID
 * Note: This is lossy and only for comparison purposes
 */
export function numberToMessageIdPrefix(num: bigint): string {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, num, false);
  const bytes = new Uint8Array(buffer);
  return btoa(String.fromCharCode(...bytes));
}

export function decodeFauxStateVector(
  sv: FauxStateVector,
): DecodedFauxStateVector {
  const decoder = decoding.createDecoder(sv);
  const count = decoding.readVarUint(decoder);
  const messageIds: string[] = [];
  
  for (let i = 0; i < count; i++) {
    messageIds.push(decoding.readVarString(decoder));
  }
  
  return { messageIds };
}

/**
 * Encodes a faux state vector with multiple message IDs.
 * @param sv - The faux state vector to encode.
 * @returns The encoded faux state vector.
 *
 * The format is:
 * - The number of message IDs (varuint)
 * - For each message ID:
 *   - The messageId (varstring)
 */
export function encodeFauxStateVector(
  sv: DecodedFauxStateVector,
): FauxStateVector {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, sv.messageIds.length);
  
  for (const messageId of sv.messageIds) {
    encoding.writeVarString(encoder, messageId);
  }
  
  return encoding.toUint8Array(encoder) as FauxStateVector;
}

export function getEmptyFauxUpdateList(): FauxUpdate {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  return encoding.toUint8Array(encoder) as FauxUpdate;
}

/**
 * Encodes an update list.
 * @param list - The update list to encode.
 * @returns The encoded update list.
 *
 * The format is:
 * - The number of updates
 * - For each update:
 *   - The messageId (varstring) - the base64 encoded sha256 of the update
 *   - The update (varuint8array) - the encrypted update
 */
export function encodeFauxUpdateList(list: DecodedUpdateList): FauxUpdate {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, list.length);
  for (const update of list) {
    encoding.writeVarString(encoder, update.messageId);
    encoding.writeVarUint8Array(encoder, update.update);
  }
  return encoding.toUint8Array(encoder) as FauxUpdate;
}
/**
 * Appends an update to the update list.
 * @param list - The update list to append to.
 * @param update - The update to append.
 * @returns The updated update list.
 */
export function appendFauxUpdateList(
  list: FauxUpdate,
  updates: DecodedUpdate[],
): FauxUpdate {
  const decoder = decoding.createDecoder(list);
  const count = decoding.readVarUint(decoder);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, count + updates.length);
  for (const update of updates) {
    encoding.writeVarString(encoder, update.messageId);
    encoding.writeVarUint8Array(encoder, update.update);
  }
  encoding.writeUint8Array(encoder, decoding.readTailAsUint8Array(decoder));
  return encoding.toUint8Array(encoder) as FauxUpdate;
}

/**
 * Encodes a single update into a faux update.
 */
export function encodeFauxUpdate(update: Update): FauxUpdate {
  return encodeFauxUpdateList([
    {
      update,
      messageId: toBase64(digest(update)),
    },
  ]);
}

/**
 * Decodes an update list.
 * @param list - The update list to decode.
 * @returns The decoded update list.
 */
export function decodeFauxUpdateList(list: FauxUpdate): DecodedUpdateList {
  const decoder = decoding.createDecoder(list);
  const count = decoding.readVarUint(decoder);
  const updates: DecodedUpdate[] = [];
  for (let i = 0; i < count; i++) {
    const update = {
      messageId: decoding.readVarString(decoder),
      update: decoding.readVarUint8Array(decoder) as FauxUpdate,
    };
    if (update.messageId !== toBase64(digest(update.update))) {
      throw new Error("Invalid message, messageId does not match update");
    }
    updates.push(update);
  }
  return updates;
}

export type DecodedUpdate = {
  messageId: string;
  update: Update;
};

export type DecodedUpdateList = DecodedUpdate[];
