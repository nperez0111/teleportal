import { toBase64 } from "lib0/buffer";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { digest } from "lib0/hash/sha256";

import type { StateVector, SyncStep2Update, Update } from "teleportal";
import { EncryptedBinary } from "teleportal/encryption-key";
import type { LamportClockValue } from "./lamport-clock";

/**
 * Represents a message identifier in the encryption state vector
 */
export type EncryptedMessageId = string;

/**
 * Represents a snapshot identifier in the encryption protocol
 */
export type EncryptedSnapshotId = string;

/**
 * The binary representation of a {@link DecodedEncryptedStateVector}
 */
export type EncryptedStateVector = StateVector;

/**
 * The decoded representation of a {@link EncryptedStateVector}
 */
export type DecodedEncryptedStateVector = {
  snapshotId: EncryptedSnapshotId;
  serverVersion: number;
};

/**
 * Encodes a {@link DecodedEncryptedStateVector} to a {@link EncryptedStateVector}
 * The format is:
 *  - version: 0
 *  - snapshot id: string (empty if none)
 *  - server version: number
 *
 * Can be decoded with {@link decodeFromStateVector}
 */
export function encodeToStateVector(
  state: DecodedEncryptedStateVector,
): EncryptedStateVector {
  return encoding.encode((encoder) => {
    // version
    encoding.writeVarUint(encoder, 0);
    // snapshot id (empty string for none)
    encoding.writeVarString(encoder, state.snapshotId ?? "");
    // server version
    encoding.writeVarUint(
      encoder,
      Number.isFinite(state.serverVersion) ? state.serverVersion : 0,
    );
  }) as EncryptedStateVector;
}

/**
 * Decodes a {@link EncryptedStateVector} to a {@link DecodedEncryptedStateVector} (originally created by {@link encodeToStateVector})
 */
export function decodeFromStateVector(
  stateVector: EncryptedStateVector,
): DecodedEncryptedStateVector {
  try {
    const decoder = decoding.createDecoder(stateVector);
    // version
    const version = decoding.readVarUint(decoder);
    if (version !== 0) {
      throw new Error("Invalid version");
    }
    const snapshotId = decoding.readVarString(decoder);
    const serverVersion = decoding.readVarUint(decoder);
    return {
      snapshotId,
      serverVersion,
    };
  } catch (e) {
    throw new Error("Failed to decode encrypted state vector", {
      cause: {
        error: e,
        message: stateVector,
      },
    });
  }
}

/**
 * The decoded representation of a {@link EncryptedUpdatePayload}
 */
export type DecodedEncryptedUpdatePayload = {
  id: EncryptedMessageId;
  snapshotId: EncryptedSnapshotId;
  timestamp: LamportClockValue;
  payload: EncryptedBinary;
  serverVersion?: number;
};

/**
 * The binary representation of a {@link DecodedEncryptedUpdatePayload}
 */
export type EncryptedUpdatePayload = Update;

export type EncryptedSnapshot = {
  id: EncryptedSnapshotId;
  parentSnapshotId?: EncryptedSnapshotId | null;
  payload: EncryptedBinary;
};

export type DecodedEncryptedDocumentMessage =
  | { type: "snapshot"; snapshot: EncryptedSnapshot }
  | { type: "update"; updates: DecodedEncryptedUpdatePayload[] };

/**
 * Encodes a {@link DecodedEncryptedUpdatePayload} to a {@link EncryptedUpdatePayload}
 */
export function encodeEncryptedUpdateMessages(
  updates: DecodedEncryptedUpdatePayload[],
): EncryptedUpdatePayload {
  return encoding.encode((encoder) => {
    // version
    encoding.writeVarUint(encoder, 0);
    // kind (0 = updates)
    encoding.writeUint8(encoder, 0);
    // length
    encoding.writeVarUint(encoder, updates.length);
    // updates
    for (const update of updates) {
      if (typeof update.snapshotId !== "string") {
        throw new Error("Encrypted update is missing snapshotId");
      }
      encoding.writeVarString(encoder, update.snapshotId);
      // timestamp
      // client id
      encoding.writeVarUint(encoder, update.timestamp[0]);
      // counter
      encoding.writeVarUint(encoder, update.timestamp[1]);
      const hasServerVersion = typeof update.serverVersion === "number";
      encoding.writeUint8(encoder, hasServerVersion ? 1 : 0);
      if (hasServerVersion) {
        encoding.writeVarUint(encoder, update.serverVersion!);
      }
      // payload
      encoding.writeVarUint8Array(encoder, update.payload);
    }
  }) as EncryptedUpdatePayload;
}

/**
 * Encodes a {@link EncryptedBinary} to a {@link EncryptedUpdatePayload}
 */
export function encodeEncryptedUpdate(
  update: EncryptedBinary,
  snapshotId: EncryptedSnapshotId,
  timestamp: LamportClockValue,
  serverVersion?: number,
): EncryptedUpdatePayload {
  return encodeEncryptedUpdateMessages([
    {
      id: toBase64(digest(update)),
      snapshotId,
      timestamp,
      payload: update,
      serverVersion,
    },
  ]);
}

export function encodeEncryptedSnapshot(
  snapshot: EncryptedSnapshot,
): EncryptedUpdatePayload {
  return encoding.encode((encoder) => {
    // version
    encoding.writeVarUint(encoder, 0);
    // kind (1 = snapshot)
    encoding.writeUint8(encoder, 1);
    // snapshot id
    encoding.writeVarString(encoder, snapshot.id);
    // parent snapshot id
    encoding.writeVarString(encoder, snapshot.parentSnapshotId ?? "");
    // payload
    encoding.writeVarUint8Array(encoder, snapshot.payload);
  }) as EncryptedUpdatePayload;
}

/**
 * Decodes a {@link EncryptedUpdatePayload} to a {@link DecodedEncryptedUpdatePayload} (originally created by {@link encodeEncryptedUpdate})
 */
export function decodeEncryptedUpdate(
  update: EncryptedUpdatePayload,
): DecodedEncryptedDocumentMessage {
  try {
    const decoder = decoding.createDecoder(update);
    // version
    const version = decoding.readVarUint(decoder);
    if (version !== 0) {
      throw new Error("Invalid version");
    }
    const kind = decoding.readUint8(decoder);
    if (kind === 1) {
      const snapshotId = decoding.readVarString(decoder);
      const parentSnapshotId = decoding.readVarString(decoder);
      const payload = decoding.readVarUint8Array(decoder) as EncryptedBinary;
      return {
        type: "snapshot",
        snapshot: {
          id: snapshotId,
          parentSnapshotId: parentSnapshotId || null,
          payload,
        },
      };
    }
    if (kind !== 0) {
      throw new Error("Invalid encrypted update kind");
    }
    const messages: DecodedEncryptedUpdatePayload[] = [];
    const length = decoding.readVarUint(decoder);
    for (let i = 0; i < length; i++) {
      const snapshotId = decoding.readVarString(decoder);
      // timestamp
      const clientId = decoding.readVarUint(decoder);
      const counter = decoding.readVarUint(decoder);
      const hasServerVersion = decoding.readUint8(decoder) === 1;
      const serverVersion = hasServerVersion
        ? decoding.readVarUint(decoder)
        : undefined;
      // payload
      const payload = decoding.readVarUint8Array(decoder) as EncryptedBinary;

      messages.push({
        id: toBase64(digest(payload)),
        snapshotId,
        timestamp: [clientId, counter],
        payload,
        serverVersion,
      });
    }
    return { type: "update", updates: messages };
  } catch (err) {
    throw new Error("Failed to decode encrypted update", {
      cause: {
        error: err,
        message: update,
      },
    });
  }
}

/**
 * The binary representation of a {@link DecodedEncryptedSyncStep2}
 */
export type EncryptedSyncStep2 = SyncStep2Update;

/**
 * The decoded representation of a {@link EncryptedSyncStep2}
 */
export type DecodedEncryptedSyncStep2 = {
  snapshot?: EncryptedSnapshot | null;
  updates: DecodedEncryptedUpdatePayload[];
};

/**
 * Encodes a {@link DecodedEncryptedSyncStep2} to a {@link EncryptedSyncStep2}
 * The format is:
 *  - version: 0
 *  - snapshot flag: boolean
 *  - optional snapshot payload (id, parent id, ciphertext)
 *  - updates:
 *    - snapshot id: string
 *    - client id: number
 *    - counter: number
 *    - server version: number
 *    - payload: ciphertext
 *
 * Can be decoded with {@link decodeFromSyncStep2}
 */
export function encodeToSyncStep2(
  syncStep2: DecodedEncryptedSyncStep2,
): EncryptedSyncStep2 {
  return encoding.encode((encoder) => {
    // version
    encoding.writeVarUint(encoder, 0);
    // snapshot flag
    const snapshot = syncStep2.snapshot ?? null;
    encoding.writeUint8(encoder, snapshot ? 1 : 0);
    if (snapshot) {
      encoding.writeVarString(encoder, snapshot.id);
      encoding.writeVarString(encoder, snapshot.parentSnapshotId ?? "");
      encoding.writeVarUint8Array(encoder, snapshot.payload);
    }
    // updates length
    encoding.writeVarUint(encoder, syncStep2.updates.length);
    for (const update of syncStep2.updates) {
      encoding.writeVarString(encoder, update.snapshotId);
      encoding.writeVarUint(encoder, update.timestamp[0]);
      encoding.writeVarUint(encoder, update.timestamp[1]);
      const hasServerVersion = typeof update.serverVersion === "number";
      encoding.writeUint8(encoder, hasServerVersion ? 1 : 0);
      if (hasServerVersion) {
        encoding.writeVarUint(encoder, update.serverVersion!);
      }
      encoding.writeVarUint8Array(encoder, update.payload);
    }
  }) as EncryptedSyncStep2;
}

/**
 * Decodes a {@link EncryptedSyncStep2} to a {@link DecodedEncryptedSyncStep2} (originally created by {@link encodeToSyncStep2})
 */
export function decodeFromSyncStep2(
  syncStep2: EncryptedSyncStep2,
): DecodedEncryptedSyncStep2 {
  try {
    const decoder = decoding.createDecoder(syncStep2);
    const updates: DecodedEncryptedUpdatePayload[] = [];
    // version
    const version = decoding.readVarUint(decoder);
    if (version !== 0) {
      throw new Error("Invalid version");
    }
    const hasSnapshot = decoding.readUint8(decoder) === 1;
    let snapshot: EncryptedSnapshot | null = null;
    if (hasSnapshot) {
      const snapshotId = decoding.readVarString(decoder);
      const parentSnapshotId = decoding.readVarString(decoder);
      const payload = decoding.readVarUint8Array(decoder) as EncryptedBinary;
      snapshot = {
        id: snapshotId,
        parentSnapshotId: parentSnapshotId || null,
        payload,
      };
    }
    const length = decoding.readVarUint(decoder);
    for (let i = 0; i < length; i++) {
      const snapshotId = decoding.readVarString(decoder);
      const clientId = decoding.readVarUint(decoder);
      const lamportClock = decoding.readVarUint(decoder);
      const hasServerVersion = decoding.readUint8(decoder) === 1;
      const serverVersion = hasServerVersion
        ? decoding.readVarUint(decoder)
        : undefined;
      const payload = decoding.readVarUint8Array(decoder) as EncryptedBinary;
      updates.push({
        id: toBase64(digest(payload)),
        snapshotId,
        timestamp: [clientId, lamportClock],
        payload,
        serverVersion,
      });
    }
    return { snapshot, updates };
  } catch (e) {
    throw new Error("Failed to decode encrypted sync step 2 message", {
      cause: {
        error: e,
        message: syncStep2,
      },
    });
  }
}

export function getEmptyEncryptedStateVector(): EncryptedStateVector {
  return encodeToStateVector({ snapshotId: "", serverVersion: 0 });
}

export function getEmptyEncryptedSyncStep2(): EncryptedSyncStep2 {
  return encodeToSyncStep2({ updates: [] });
}

export function getEmptyEncryptedUpdate(): EncryptedUpdatePayload {
  return encodeEncryptedUpdateMessages([]);
}

export function isEmptyEncryptedStateVector(
  stateVector: EncryptedStateVector,
): boolean {
  const empty = getEmptyEncryptedStateVector();
  return stateVector.every((value, index) => value === empty[index]);
}

export function isEmptyEncryptedSyncStep2(
  syncStep2: EncryptedSyncStep2,
): boolean {
  const empty = getEmptyEncryptedSyncStep2();
  return syncStep2.every((value, index) => value === empty[index]);
}

export function isEmptyEncryptedUpdate(
  update: EncryptedUpdatePayload,
): boolean {
  const empty = getEmptyEncryptedUpdate();
  return update.every((value, index) => value === empty[index]);
}
