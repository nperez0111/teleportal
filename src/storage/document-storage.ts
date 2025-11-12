import type { StateVector, SyncStep2Update, Update } from "teleportal";
/**
 * A storage interface for a document.
 */
export abstract class DocumentStorage {
  /**
   * The type of the storage.
   */
  public readonly type = "document-storage";

  /**
   * Whether the document is encrypted.
   */
  public encrypted = false;

  /**
   * Stores an update for a document.
   */
  abstract write(key: string, update: Update): Promise<void>;

  /**
   * Implements synchronization with a client's state vector.
   */
  abstract handleSyncStep1(
    key: string,
    syncStep1: StateVector,
  ): Promise<{
    update: SyncStep2Update;
    stateVector: StateVector;
  }>;

  /**
   * Implements synchronization with a client's state vector.
   */
  abstract handleSyncStep2(
    key: string,
    syncStep2: SyncStep2Update,
  ): Promise<void>;

  /**
   * Fetches the update and computes a state vector for a document.
   */
  abstract fetch(key: string): Promise<{
    update: Update;
    stateVector: StateVector;
  } | null>;

  /**
   * Unloads a document from storage.
   */
  unload(key: string): Promise<void> | void {
    return;
  }

  transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  // /**
  //  * Creates a snapshot of a document.
  //  */
  // snapshot(
  //   key: string,
  //   name: string,
  // ): Promise<{
  //   id: string;
  //   meta: {
  //     name: string;
  //     createdAt: number;
  //   };
  // } | null>;

  // /**
  //  * Gets a snapshot of a document.
  //  */
  // getSnapshot(
  //   key: string,
  //   snapshotId: string,
  // ): Promise<{
  //   id: string;
  //   meta: {
  //     name: string;
  //     createdAt: number;
  //   };
  //   update: Update;
  //   stateVector: StateVector;
  // } | null>;

  // /**
  //  * Lists all snapshots of a document.
  //  */
  // getSnapshots(key: string): Promise<
  //   {
  //     id: string;
  //     meta: {
  //       name: string;
  //       createdAt: number;
  //     };
  //   }[]
  // >;

  // /**
  //  * Restores a document from a snapshot.
  //  */
  // restore(
  //   key: string,
  //   snapshotId: string,
  //   name: string,
  // ): Promise<{
  //   id: string;
  //   meta: {
  //     name: string;
  //     createdAt: number;
  //   };
  //   update: Update;
  //   stateVector: StateVector;
  // } | null>;
}
