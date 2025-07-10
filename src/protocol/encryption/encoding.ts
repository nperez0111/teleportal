import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import type { StateVector, Update } from "teleportal";
import { digest } from "lib0/hash/sha256";
import { fromBase64, toBase64 } from "lib0/buffer.js";

export type DecodedFauxStateVector = {
  messageIds: Uint8Array[];
};

export type FauxStateVector = StateVector;
export type FauxUpdate = Update;

/**
 * Converts Uint8Array to string for use in Set/Map operations
 */
export function messageIdToString(messageId: Uint8Array): string {
  return toBase64(messageId);
}

/**
 * Converts hex string back to Uint8Array
 */
export function stringToMessageId(str: string): Uint8Array {
  return fromBase64(str);
}

export function decodeFauxStateVector(
  sv: FauxStateVector,
): DecodedFauxStateVector {
  const decoder = decoding.createDecoder(sv);
  const count = decoding.readVarUint(decoder);
  const messageIds: Uint8Array[] = [];

  for (let i = 0; i < count; i++) {
    // Read exactly 32 bytes for SHA256 hash
    messageIds.push(decoding.readUint8Array(decoder, 32));
  }

  return { messageIds };
}

/**
 * Encodes a faux state vector with multiple message IDs as fixed-size Uint8Arrays.
 * @param sv - The faux state vector to encode.
 * @returns The encoded faux state vector.
 *
 * The format is:
 * - The number of message IDs (varuint)
 * - For each message ID:
 *   - The messageId (32 bytes) - fixed-size SHA256 hash
 */
export function encodeFauxStateVector(
  sv: DecodedFauxStateVector,
): FauxStateVector {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, sv.messageIds.length);

  for (const messageId of sv.messageIds) {
    // Write exactly 32 bytes for SHA256 hash
    encoding.writeUint8Array(encoder, messageId);
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
 *   - The messageId (32 bytes) - fixed-size SHA256 hash
 *   - The update (varuint8array) - the encrypted update
 */
export function encodeFauxUpdateList(list: DecodedUpdateList): FauxUpdate {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, list.length);
  for (const update of list) {
    // Write exactly 32 bytes for SHA256 hash
    encoding.writeUint8Array(encoder, update.messageId);
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
    // Write exactly 32 bytes for SHA256 hash
    encoding.writeUint8Array(encoder, update.messageId);
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
      messageId: digest(update),
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
    // Read exactly 32 bytes for SHA256 hash
    const messageId = decoding.readUint8Array(decoder, 32);
    const update = decoding.readVarUint8Array(decoder) as FauxUpdate;

    // Verify messageId matches update hash
    const expectedMessageId = digest(update);
    if (!arraysEqual(messageId, expectedMessageId)) {
      throw new Error("Invalid message, messageId does not match update");
    }

    updates.push({ messageId, update });
  }
  return updates;
}

/**
 * Helper function to compare two Uint8Arrays for equality
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export type DecodedUpdate = {
  messageId: Uint8Array;
  update: Update;
};

export type DecodedUpdateList = DecodedUpdate[];
