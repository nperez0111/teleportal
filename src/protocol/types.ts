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
 * A blob message, which can be either a blob-part or a request-blob.
 */
export type BlobMessage = Tag<Uint8Array, "blob-message">;

/**
 * A decoded Y.js blob message (either blob-part or request-blob).
 */
export type DecodedBlobMessage =
  | DecodedBlobPartMessage
  | DecodedRequestBlobMessage;

/**
 * A Y.js blob part message, which includes file metadata and binary data.
 */
export type BlobPartMessage = Tag<Uint8Array, "blob-part">;

/**
 * A decoded blob part message.
 */
export type DecodedBlobPartMessage = {
  type: "blob-part";
  segmentIndex: number;
  totalSegments: number;
  contentId: string;
  name: string;
  contentType: string;
  data: Uint8Array;
};

/**
 * A request blob message, which requests a file by content ID.
 */
export type RequestBlobMessage = Tag<Uint8Array, "request-blob">;

/**
 * A decoded request blob message.
 */
export type DecodedRequestBlobMessage = {
  type: "request-blob";
  requestId: string;
  contentId: string;
  name?: string;
};

/**
 * Any Y.js update which concerns a document.
 */
export type DocStep = SyncStep1 | SyncStep2 | UpdateStep | AuthMessage;

/**
 * Any Y.js update which contains awareness updates.
 */
export type AwarenessStep = AwarenessRequestMessage | AwarenessUpdateMessage;

/**
 * A Y.js message which concerns a document and encloses a {@link DocStep} and the document name.
 */
export type EncodedDocUpdateMessage<T extends DocStep> = Tag<Uint8Array, T>;
