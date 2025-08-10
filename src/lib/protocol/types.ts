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
 * A Y.js awareness update message, which includes the document name and the update.
 */
export type AwarenessRequestMessage = Tag<Uint8Array, "awareness-request">;

/**
 * A decoded Y.js auth message
 */
export type DecodedAwarenessRequest = {
  type: "awareness-request";
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
 * A Y.js SyncStep2 update, as an UpdateV2.
 */
export type SyncStep2Update = Tag<Uint8Array, "sync-step-2-update">;

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
  update: SyncStep2Update;
};

/**
 * A Y.js sync done message that indicates both sync step 1 and sync step 2 have been exchanged
 */
export type SyncDone = Tag<Uint8Array, "sync-done">;

/**
 * A decoded Y.js {@link SyncDone} message
 */
export type DecodedSyncDone = {
  type: "sync-done";
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
 * A Y.js update step as encoded by the y-protocols implementation.
 */
export type AuthMessage = Tag<Uint8Array, "auth-message">;

/**
 * A decoded Y.js auth message
 */
export type DecodedAuthMessage = {
  type: "auth-message";
  permission: "denied";
  reason: string;
};

/**
 * Any Y.js update which concerns a document.
 */
export type DocStep =
  | SyncStep1
  | SyncStep2
  | SyncDone
  | UpdateStep
  | AuthMessage;

/**
 * Any Y.js update which contains awareness updates.
 */
export type AwarenessStep = AwarenessRequestMessage | AwarenessUpdateMessage;

/**
 * A Y.js message which concerns a document and encloses a {@link DocStep} and the document name.
 */
export type EncodedDocUpdateMessage<T extends DocStep> = Tag<Uint8Array, T>;
