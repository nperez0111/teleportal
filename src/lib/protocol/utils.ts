import type { StateVector, SyncStep2Update, Update } from "./types";

/**
 * An empty Update for use as a placeholder.
 */
export const getEmptyUpdate = (): Update =>
  new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]) as Update;

/**
 * An empty StateVector for use as a placeholder.
 */
export const getEmptyStateVector = (): StateVector =>
  new Uint8Array([0]) as StateVector;

/**
 * Checks if an update is empty.
 */
export function isEmptyUpdate(update: Update): boolean {
  return (
    update[0] === 0 &&
    update[1] === 0 &&
    update[2] === 0 &&
    update[3] === 0 &&
    update[4] === 0 &&
    update[5] === 0 &&
    update[6] === 1 &&
    update[7] === 0 &&
    update[8] === 0 &&
    update[9] === 0 &&
    update[10] === 0 &&
    update[11] === 0 &&
    update[12] === 0 &&
    update.length === 13
  );
}

export function isEmptySyncStep2(syncStep2: SyncStep2Update): boolean {
  return isEmptyUpdate(syncStep2 as any);
}

/**
 * Checks if a state vector is empty.
 */
export function isEmptyStateVector(stateVector: StateVector): boolean {
  return stateVector[0] === 0 && stateVector.length === 1;
}
