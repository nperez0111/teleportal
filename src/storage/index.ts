import type { StateVector, Update } from "../protocol";

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
 * A storage interface for a document.
 */
export interface DocumentStorage {
  /**
   * Stores an update for a document.
   */
  write(key: string, update: Update): Promise<void>;

  /**
   * Fetches the update and computes a state vector for a document.
   */
  fetch(key: string): Promise<{
    update: Update;
    stateVector: StateVector;
  }>;

  /**
   * Destroys the underlying storage for a document.
   */
  destroy(): Promise<void>;
}
