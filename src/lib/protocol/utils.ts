import type { StateVector, Update } from "./types";

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
  const empty = getEmptyUpdate();
  // purposely over-scan by 1 to check for trailing values
  for (let i = 0; i <= empty.length; i++) {
    if (update[i] !== empty[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Checks if a state vector is empty.
 */
export function isEmptyStateVector(stateVector: StateVector): boolean {
  const empty = getEmptyStateVector();
  // purposely over-scan by 1 to check for trailing values
  for (let i = 0; i <= empty.length; i++) {
    if (stateVector[i] !== empty[i]) {
      return false;
    }
  }
  return true;
}
