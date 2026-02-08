import type {
  DecodedEncryptedStateVector,
  DecodedEncryptedSyncStep2,
  EncryptedMessageId,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedSnapshot,
} from "./encoding";
import {
  DecodedEncryptedUpdatePayload,
  encodeToStateVector,
  encodeToSyncStep2,
} from "./encoding";
import type { ClientId, Counter } from "./lamport-clock";

/**
 * A mapping of {@link ClientId} to a mapping of {@link Counter} to {@link EncryptedMessageId}
 */
export type SeenMessageMapping = Record<
  ClientId,
  Record<Counter, EncryptedMessageId>
>;

/**
 * Returns the {@link DecodedEncryptedStateVector} for a snapshot/version pair.
 */
export function getDecodedStateVector(
  snapshotId: string,
  serverVersion: number,
): DecodedEncryptedStateVector {
  return {
    snapshotId,
    serverVersion,
  };
}

/**
 * Returns the {@link EncryptedStateVector} for a snapshot/version pair.
 */
export function getEncryptedStateVector(
  snapshotId: string,
  serverVersion: number,
): EncryptedStateVector {
  return encodeToStateVector(getDecodedStateVector(snapshotId, serverVersion));
}

/**
 * Returns a decoded sync step 2 payload from updates and an optional snapshot.
 */
export function getDecodedSyncStep2(
  updates: DecodedEncryptedUpdatePayload[],
  snapshot?: EncryptedSnapshot | null,
): DecodedEncryptedSyncStep2 {
  return {
    snapshot: snapshot ?? null,
    updates,
  };
}

/**
 * Returns an encoded sync step 2 payload from updates and an optional snapshot.
 */
export function getEncryptedSyncStep2(
  updates: DecodedEncryptedUpdatePayload[],
  snapshot?: EncryptedSnapshot | null,
): EncryptedSyncStep2 {
  return encodeToSyncStep2(getDecodedSyncStep2(updates, snapshot));
}
