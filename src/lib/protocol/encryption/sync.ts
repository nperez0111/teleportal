import { EncryptedBinary } from "teleportal/encryption-key";
import type {
  DecodedEncryptedStateVector,
  DecodedEncryptedSyncStep2,
  EncryptedMessageId,
  EncryptedStateVector,
  EncryptedSyncStep2,
} from "./encoding";
import {
  DecodedEncryptedUpdatePayload,
  encodeToStateVector,
  encodeToSyncStep2,
} from "./encoding";
import type { ClientId, Counter, LamportClockValue } from "./lamport-clock";
import {
  computeSetDifferenceFromStateVector,
  toRangeBased,
} from "./range-reconciliation";

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
 * returns a {@link EncryptedSyncStep2} of the messages that the other client has not seen yet.
 * This implementation uses range-based set reconciliation, which is more efficient for many consecutive messages.
 *
 * Given a {@link DecodedEncryptedStateVector} of the other client,
 * returns a {@link DecodedEncryptedSyncStep2} of the messages that the other client has not seen yet.
 */
export async function getDecodedSyncStep2(
  seenMessages: SeenMessageMapping,
  getEncryptedMessageUpdate: (
    messageId: EncryptedMessageId,
  ) => Promise<EncryptedBinary | null>,
  syncStep1: DecodedEncryptedStateVector = { clocks: new Map() },
): Promise<DecodedEncryptedSyncStep2> {
  // Convert to range-based format
  const rangeBased = toRangeBased(seenMessages);

  // Compute set difference using state vector (more efficient)
  const difference = computeSetDifferenceFromStateVector(
    rangeBased,
    syncStep1.clocks,
  );

  // Fetch all needed messages
  const promiseMessages: Promise<DecodedEncryptedUpdatePayload | null>[] = [];
  for (const [clientId, messageMap] of difference.entries()) {
    for (const [counter, messageId] of messageMap.entries()) {
      const timestamp: LamportClockValue = [clientId, counter];
      promiseMessages.push(
        getEncryptedMessageUpdate(messageId).then((payload) =>
          payload
            ? {
                id: messageId,
                timestamp,
                payload,
              }
            : null,
        ),
      );
    }
  }

  const messages = (await Promise.all(promiseMessages)).filter(
    (message) => message !== null,
  ) as DecodedEncryptedUpdatePayload[];

  return {
    messages,
  };
}

/**
 * Range-based version of getEncryptedSyncStep2 that uses range-based set reconciliation
 * for more efficient computation when there are many consecutive messages.
 *
 * Given a {@link DecodedEncryptedStateVector} of the other client,
 * returns a {@link EncryptedSyncStep2} of the messages that the other client has not seen yet.
 */
export async function getEncryptedSyncStep2(
  seenMessages: SeenMessageMapping,
  getEncryptedMessageUpdate: (
    messageId: EncryptedMessageId,
  ) => Promise<EncryptedBinary | null>,
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
