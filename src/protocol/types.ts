export type Tag<T, Tag> = T & { _tag: Tag };

/**
 * A Y.js awareness update message, which includes the document name and the update.
 */
export type AwarenessUpdateMessage = Tag<Uint8Array, "awareness-update">;

/**
 * A decoded Y.js awareness update message.
 */
export type DecodedAwarenessUpdateMessage = {
  type: "awareness-update";
  update: AwarenessUpdateMessage;
};

/**
 * A message for communication between client & server
 * Implementing operations like snapshots
 */
export type SnapshotVersionMessage = SnapshotRequest;

export type SnapshotList = {
  type: "list-snapshots";
};

export type Snapshot = {
  /**
   * The id of the snapshot, incremented by 1 for each new snapshot
   */
  id: number;
  /**
   * The name of the snapshot
   */
  name: string;
  /**
   * The timestamp of the snapshot, in milliseconds since the Unix epoch
   */
  createdAt: number;
  /**
   * The user id of the user who made the snapshot
   */
  userId: string;
};

export type SnapshotListResponse = {
  type: "list-snapshots-response";
  snapshots: Snapshot[];
};

/**
 * A request to make a snapshot of the current state of the document
 */
export type SnapshotRequest = {
  type: "snapshot-request";
  /**
   * The name of the snapshot to be made
   */
  name: string;
  /**
   * The name of the current snapshot (for any un-snapshotted changes that have not been committed)
   */
  currentSnapshotName: string;
};

/**
 * A request to fetch a specific snapshot by ID
 */
export type SnapshotFetchRequest = {
  type: "snapshot-fetch-request";
  /**
   * The ID of the snapshot to fetch
   */
  snapshotId: number;
};

/**
 * A response containing a specific snapshot's metadata and content
 */
export type SnapshotFetchResponse = {
  type: "snapshot-fetch-response";
  /**
   * The snapshot metadata
   */
  snapshot: Snapshot;
  /**
   * The snapshot's document content as a Y.js update
   */
  content: Uint8Array;
};

/**
 * A request to revert the document to a specific snapshot
 */
export type SnapshotRevertRequest = {
  type: "snapshot-revert-request";
  /**
   * The ID of the snapshot to revert to
   */
  snapshotId: number;
};

/**
 * A response confirming a document revert to a snapshot
 */
export type SnapshotRevertResponse = {
  type: "snapshot-revert-response";
  /**
   * The snapshot that was reverted to
   */
  snapshot: Snapshot;
};

/**
 * An event notification that a new snapshot was created
 */
export type SnapshotCreatedEvent = {
  type: "snapshot-created-event";
  /**
   * The newly created snapshot
   */
  snapshot: Snapshot;
};

/**
 * An event notification that a document was reverted to a snapshot
 */
export type SnapshotRevertedEvent = {
  type: "snapshot-reverted-event";
  /**
   * The snapshot that was reverted to
   */
  snapshot: Snapshot;
  /**
   * The user ID who performed the revert
   */
  revertedBy: string;
};

/**
 * Union type for all snapshot-related messages
 */
export type SnapshotMessageType =
  | SnapshotList
  | SnapshotListResponse
  | SnapshotRequest
  | SnapshotFetchRequest
  | SnapshotFetchResponse
  | SnapshotRevertRequest
  | SnapshotRevertResponse
  | SnapshotCreatedEvent
  | SnapshotRevertedEvent;

/**
 * A decoded snapshot message.
 */
export type DecodedSnapshotMessage = {
  type: SnapshotMessageType["type"];
  payload: SnapshotMessageType;
};

/**
 * A Y.js update, always encoded as UpdateV2.
 */
export type Update = Tag<Uint8Array, "update">;

/**
 * A Y.js state vector.
 */
export type StateVector = Tag<Uint8Array, "state-vector">;

/**
 * A Y.js sync step 1 update as encoded by the y-protocols implementation.
 */
export type SyncStep1 = Tag<Uint8Array, "sync-step-1">;

/**
 * A decoded Y.js {@link SyncStep1} update
 */
export type DecodedSyncStep1 = {
  type: "sync-step-1";
  sv: StateVector;
};

/**
 * A Y.js sync step 2 update as encoded by the y-protocols implementation.
 */
export type SyncStep2 = Tag<Uint8Array, "sync-step-2">;

/**
 * A decoded Y.js {@link SyncStep2} update
 */
export type DecodedSyncStep2 = {
  type: "sync-step-2";
  update: Update;
};

/**
 * A Y.js update step as encoded by the y-protocols implementation.
 */
export type UpdateStep = Tag<Uint8Array, "update-step">;

/**
 * A decoded Y.js {@link UpdateStep}
 */
export type DecodedUpdateStep = {
  type: "update";
  update: Update;
};

/**
 * Any Y.js update which concerns a document.
 */
export type DocStep = SyncStep1 | SyncStep2 | UpdateStep;

/**
 * A Y.js message which concerns a document and encloses a {@link DocStep} and the document name.
 */
export type EncodedDocUpdateMessage<T extends DocStep> = Tag<Uint8Array, T>;
