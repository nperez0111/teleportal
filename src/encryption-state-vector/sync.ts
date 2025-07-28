import type { Update } from "teleportal/protocol";
import type {
  DecodedEncryptedStateVector,
  DecodedEncryptedSyncStep2,
  EncryptedMessageId,
  EncryptedStateVector,
  EncryptedSyncStep2,
} from "./encoding";
import {
  encodeToStateVector,
  encodeToSyncStep2,
  EncryptedUpdateMessage,
} from "./encoding";
import type { ClientId, Counter, LamportClockValue } from "./lamport-clock";

/**
 * A mapping of {@link ClientId} to a mapping of {@link Counter} to {@link EncryptedMessageId}
 */
export type SeenMessageMapping = Record<
  ClientId,
  Record<Counter, EncryptedMessageId>
>;

/**
 * Returns the {@link DecodedEncryptedStateVector} of the client based on the {@link SeenMessageMapping}
 */
export function getDecodedStateVector(
  seenMessages: SeenMessageMapping,
): DecodedEncryptedStateVector {
  const clocks = new Map<ClientId, Counter>();
  for (const [seenClientId, messages] of Object.entries(seenMessages)) {
    for (const [seenCounter] of Object.entries(messages)) {
      const timestamp = [
        parseInt(seenClientId),
        parseInt(seenCounter!),
      ] as LamportClockValue;
      const counter = clocks.get(timestamp[0]);
      if (counter === undefined || counter < timestamp[1]) {
        clocks.set(timestamp[0], timestamp[1]);
      }
    }
  }
  return { clocks };
}

/**
 * Returns the {@link EncryptedStateVector} of the client based on the {@link SeenMessageMapping}
 */
export function getEncryptedStateVector(
  seenMessages: SeenMessageMapping,
): EncryptedStateVector {
  return encodeToStateVector(getDecodedStateVector(seenMessages));
}

/**
 * Given a {@link DecodedEncryptedStateVector} of the other client,
 * returns a {@link DecodedEncryptedSyncStep2} of the messages that the other client has not seen yet.
 */
export async function getDecodedSyncStep2(
  seenMessages: SeenMessageMapping,
  getEncryptedMessageUpdate: (messageId: EncryptedMessageId) => Promise<Update>,
  syncStep1: DecodedEncryptedStateVector = { clocks: new Map() },
): Promise<DecodedEncryptedSyncStep2> {
  const messages: Promise<EncryptedUpdateMessage>[] = [];
  for (const [seenClientId, countToMessageMapping] of Object.entries(
    seenMessages,
  )) {
    for (const [seenCounter, messageId] of Object.entries(
      countToMessageMapping,
    )) {
      const timestamp = [
        parseInt(seenClientId),
        parseInt(seenCounter!),
      ] as LamportClockValue;
      const counter = syncStep1.clocks.get(timestamp[0]);
      if (counter === undefined || counter < timestamp[1]) {
        messages.push(
          getEncryptedMessageUpdate(messageId).then((payload) =>
            EncryptedUpdateMessage.create(messageId, timestamp, payload),
          ),
        );
      }
    }
  }
  return { messages: await Promise.all(messages) };
}

/**
 * Given a {@link DecodedEncryptedStateVector} of the other client,
 * returns a {@link EncryptedSyncStep2} of the messages that the other client has not seen yet.
 */
export async function getEncryptedSyncStep2(
  seenMessages: SeenMessageMapping,
  getEncryptedMessageUpdate: (messageId: EncryptedMessageId) => Promise<Update>,
  syncStep1: DecodedEncryptedStateVector = { clocks: new Map() },
): Promise<EncryptedSyncStep2> {
  return encodeToSyncStep2(
    await getDecodedSyncStep2(
      seenMessages,
      getEncryptedMessageUpdate,
      syncStep1,
    ),
  );
}
