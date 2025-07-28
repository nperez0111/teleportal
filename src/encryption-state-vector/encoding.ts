import { fromBase64, toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import type { StateVector, SyncStep2Update, Update } from "teleportal";
import type { ClientId, Counter, LamportClockValue } from "./lamport-clock";

/**
 * Represents a message identifier in the encryption state vector
 */
export type EncryptedMessageId = string;

/**
 * The binary representation of a {@link DecodedEncryptedStateVector}
 */
export type EncryptedStateVector = StateVector;

/**
 * The decoded representation of a {@link EncryptedStateVector}
 */
export type DecodedEncryptedStateVector = {
  clocks: Map<ClientId, Counter>;
};

/**
 * Encodes a {@link DecodedEncryptedStateVector} to a {@link EncryptedStateVector}
 * The format is:
 *  - version: 0
 *  - length: number of clocks
 *  - clocks:
 *    - client id: number
 *    - counter: number
 *
 * Can be decoded with {@link decodeFromStateVector}
 */
export function encodeToStateVector(
  state: DecodedEncryptedStateVector,
): EncryptedStateVector {
  return encoding.encode((encoder) => {
    // version
    encoding.writeVarUint(encoder, 0);
    // length
    encoding.writeVarUint(encoder, state.clocks.size);
    // clocks
    for (const [clientId, counter] of state.clocks) {
      // client id
      encoding.writeVarUint(encoder, clientId);
      // counter
      encoding.writeVarUint(encoder, counter);
    }
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
    const clocks = new Map<ClientId, Counter>();
    // version
    const version = decoding.readVarUint(decoder);
    if (version !== 0) {
      throw new Error("Invalid version");
    }
    // length
    const length = decoding.readVarUint(decoder);
    for (let i = 0; i < length; i++) {
      // client id
      const clientId = decoding.readVarUint(decoder);
      // counter
      const counter = decoding.readVarUint(decoder);
      // set clock
      clocks.set(clientId, counter);
    }
    return { clocks };
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
 * The decoded representation of a {@link EncryptedUpdate}
 */
export type DecodedEncryptedUpdate = {
  id: EncryptedMessageId;
  timestamp: LamportClockValue;
  payload: Update;
};

/**
 * The binary representation of a {@link DecodedEncryptedUpdate}
 */
export type EncryptedUpdate = Update;

/**
 * Represents an encrypted update message
 */
export class EncryptedUpdateMessage {
  protected constructor(
    /**
     * Unique identifier for this message (hash of the message)
     */
    public id: EncryptedMessageId,
    /**
     * Lamport timestamp of the message
     */
    public timestamp: LamportClockValue,
    /**
     * Payload of the message (the message contents encrypted)
     */
    public payload: Update,
  ) {}

  public static create(
    id: EncryptedMessageId,
    timestamp: LamportClockValue,
    payload: Update,
  ): EncryptedUpdateMessage {
    return new EncryptedUpdateMessage(id, timestamp, payload);
  }

  public getIdentifiers(): [EncryptedMessageId, LamportClockValue] {
    return [this.id, this.timestamp];
  }

  public encode(): EncryptedUpdate {
    return encodeEncryptedUpdateMessages([this]);
  }

  public static decode(update: EncryptedUpdate): EncryptedUpdateMessage[] {
    return decodeEncryptedUpdate(update);
  }

  public static createFromUpdate(
    update: Update,
    timestamp: LamportClockValue,
  ): EncryptedUpdateMessage {
    return EncryptedUpdateMessage.create(
      toBase64(digest(update)),
      timestamp,
      update,
    );
  }
}

/**
 * Encodes a {@link EncryptedUpdateMessage} to a {@link EncryptedUpdate}
 */
export function encodeEncryptedUpdateMessages(
  updates: EncryptedUpdateMessage[],
): EncryptedUpdate {
  return encoding.encode((encoder) => {
    // version
    encoding.writeVarUint(encoder, 0);
    // length
    encoding.writeVarUint(encoder, updates.length);
    // updates
    for (const update of updates) {
      // id
      encoding.writeVarUint8Array(encoder, fromBase64(update.id));
      // timestamp
      // client id
      encoding.writeVarUint(encoder, update.timestamp[0]);
      // counter
      encoding.writeVarUint(encoder, update.timestamp[1]);
      // payload
      encoding.writeVarUint8Array(encoder, update.payload);
    }
  }) as EncryptedUpdate;
}

/**
 * Encodes a {@link Update} to a {@link EncryptedUpdate}
 */
export function encodeEncryptedUpdate(
  update: Update,
  timestamp: LamportClockValue,
): EncryptedUpdate {
  return encodeEncryptedUpdateMessages([
    EncryptedUpdateMessage.createFromUpdate(update, timestamp),
  ]);
}

/**
 * Decodes a {@link EncryptedUpdate} to a {@link EncryptedUpdateMessage} (originally created by {@link encodeEncryptedUpdate})
 */
export function decodeEncryptedUpdate(
  update: EncryptedUpdate,
): EncryptedUpdateMessage[] {
  const messages: EncryptedUpdateMessage[] = [];
  try {
    const decoder = decoding.createDecoder(update);
    // version
    const version = decoding.readVarUint(decoder);
    if (version !== 0) {
      throw new Error("Invalid version");
    }
    // length
    const length = decoding.readVarUint(decoder);
    for (let i = 0; i < length; i++) {
      // id
      const id = toBase64(decoding.readVarUint8Array(decoder));
      // timestamp
      const clientId = decoding.readVarUint(decoder);
      const counter = decoding.readVarUint(decoder);
      // payload
      const payload = decoding.readVarUint8Array(decoder) as Update;

      // create message instance
      messages.push(
        EncryptedUpdateMessage.create(id, [clientId, counter], payload),
      );
    }
    return messages;
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
  messages: EncryptedUpdateMessage[];
};

/**
 * Encodes a {@link DecodedEncryptedSyncStep2} to a {@link EncryptedSyncStep2}
 * The format is:
 *  - version: 0
 *  - client id mapping:
 *    - client id: number
 *    - index: number
 *  - messages:
 *    - id: base64 encoded message id
 *    - client id: number
 *    - lamport clock: number
 *    - payload: base64 encoded update
 *
 * Can be decoded with {@link decodeFromSyncStep2}
 */
export function encodeToSyncStep2(
  syncStep2: DecodedEncryptedSyncStep2,
): EncryptedSyncStep2 {
  return encoding.encode((encoder) => {
    // version
    encoding.writeVarUint(encoder, 0);
    // client id mapping to cache client ids instead of having to repeat them
    const clientIdMapping = new Map<ClientId, number>();
    syncStep2.messages.forEach((message) => {
      if (!clientIdMapping.has(message.timestamp[0])) {
        clientIdMapping.set(message.timestamp[0], clientIdMapping.size);
      }
    });
    const clientIdMappingLength = clientIdMapping.size;
    // client id mapping
    encoding.writeVarUint(encoder, clientIdMappingLength);
    for (const [clientId, index] of clientIdMapping) {
      encoding.writeVarUint(encoder, clientId);
      encoding.writeVarUint(encoder, index);
    }
    // messages length
    encoding.writeVarUint(encoder, syncStep2.messages.length);
    // nodes
    for (const message of syncStep2.messages) {
      // id
      encoding.writeVarUint8Array(encoder, fromBase64(message.id));
      // client id
      encoding.writeVarUint(
        encoder,
        clientIdMapping.get(message.timestamp[0])!,
      );
      // lamport clock
      encoding.writeVarUint(encoder, message.timestamp[1]);
      // payload
      encoding.writeVarUint8Array(encoder, message.payload);
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
    const messages: EncryptedUpdateMessage[] = [];
    // version
    const version = decoding.readVarUint(decoder);
    if (version !== 0) {
      throw new Error("Invalid version");
    }
    // client id mapping
    const clientIdMapping = new Map<number, ClientId>();
    const clientIdMappingLength = decoding.readVarUint(decoder);
    for (let i = 0; i < clientIdMappingLength; i++) {
      // client id
      const clientId = decoding.readVarUint(decoder);
      // index
      const index = decoding.readVarUint(decoder);
      // set client id mapping
      clientIdMapping.set(index, clientId);
    }
    // messages length
    const length = decoding.readVarUint(decoder);
    for (let i = 0; i < length; i++) {
      // id
      const id = toBase64(decoding.readVarUint8Array(decoder));
      // client id
      const clientId = clientIdMapping.get(decoding.readVarUint(decoder))!;
      // lamport clock
      const lamportClock = decoding.readVarUint(decoder);
      // payload
      const payload = decoding.readVarUint8Array(decoder);

      // add message
      messages.push(
        EncryptedUpdateMessage.create(
          id,
          [clientId, lamportClock],
          payload as Update,
        ),
      );
    }
    return { messages };
  } catch (e) {
    throw new Error("Failed to decode encrypted sync step 2 message", {
      cause: {
        error: e,
        message: syncStep2,
      },
    });
  }
}

export function getEmptyStateVector(): EncryptedStateVector {
  return encodeToStateVector({ clocks: new Map() });
}

export function getEmptySyncStep2(): EncryptedSyncStep2 {
  return encodeToSyncStep2({ messages: [] });
}

export function getEmptyEncryptedUpdate(): EncryptedUpdate {
  return encodeEncryptedUpdateMessages([]);
}
