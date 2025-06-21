import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import type { StateVector, Update } from "../../lib";
import { toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";

export type DecodedFauxStateVector = {
  messageId: string;
};

export type FauxStateVector = StateVector;
export type FauxUpdate = Update;

export function decodeFauxStateVector(
  syncStep1: FauxStateVector,
): DecodedFauxStateVector {
  const decoder = decoding.createDecoder(syncStep1);
  return {
    messageId: decoding.readVarString(decoder),
  };
}

/**
 * Encodes a faux state vector.
 * @param syncStep1 - The faux state vector to encode.
 * @returns The encoded faux state vector.
 *
 * The format is:
 * - The messageId (varstring)
 */
export function encodeFauxStateVector(
  syncStep1: DecodedFauxStateVector,
): FauxStateVector {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, syncStep1.messageId);
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
