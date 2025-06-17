import type { StateVector, Update } from "../lib";
export * from "./unstorage";
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
  } | null>;

  /**
   * Unloads a document from storage.
   */
  unload(key: string): Promise<void>;
}
