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
 * A Y.js acknowledgement message
 */
export type EncodedAckMessage = Tag<Uint8Array, "ack">;

/**
 * An acknowledgement message
 */
export type DecodedAckMessage = {
  type: "ack";
  /**
   * The id of the message that was acknowledged.
   */
  messageId: string;
};

/**
 * Any Y.js update which concerns a document.
 */
export type DocStep =
  | SyncStep1
  | SyncStep2
  | SyncDone
  | UpdateStep
  | AuthMessage
  | MilestoneListRequest
  | MilestoneListResponse
  | MilestoneSnapshotRequest
  | MilestoneSnapshotResponse
  | MilestoneCreateRequest
  | MilestoneCreateResponse
  | MilestoneUpdateNameRequest
  | MilestoneUpdateNameResponse
  | MilestoneAuthMessage;

/**
 * Any Y.js update which contains awareness updates.
 */
export type AwarenessStep = AwarenessRequestMessage | AwarenessUpdateMessage;

/**
 * A Y.js message which concerns a document and encloses a {@link DocStep} and the document name.
 */
export type EncodedDocUpdateMessage<T extends DocStep> = Tag<Uint8Array, T>;

/**
 * A file download message for initiating downloads.
 */
export type EncodedFileDownloadMessage = Tag<Uint8Array, "file-download">;

/**
 * A file upload message for initiating uploads.
 */
export type EncodedFileUploadMessage = Tag<Uint8Array, "file-upload">;

/**
 * A file part message containing chunk data and merkle proof.
 */
export type EncodedFilePartMessage = Tag<Uint8Array, "file-part">;

/**
 * A file step message for initiating uploads, downloads, or parts.
 */
export type FileStep =
  | EncodedFileDownloadMessage
  | EncodedFileUploadMessage
  | EncodedFilePartMessage;

/**
 * A file step message for initiating uploads, downloads, or parts.
 */
export type EncodedFileStep<T extends FileStep> = Tag<Uint8Array, T>;

/**
 * A decoded file upload message.
 * This message is the preamble to a file upload.
 * A client uploads a file to a sever, and a server uploads a file to a client.
 * @note Sending from local to remote.
 */
export type DecodedFileUpload = {
  type: "file-upload";
  /**
   * A client-generated identifier for resumable upload of the same file.
   */
  fileId: string;
  /**
   * Original filename
   */
  filename: string;
  /**
   * File size in bytes (max 2^53 - 1 bytes)
   */
  size: number;
  /**
   * MIME type of the file
   */
  mimeType: string;
  /**
   * Last modified timestamp of the file
   */
  lastModified: number;
  /**
   * Whether the file is encrypted
   */
  encrypted: boolean;
};

/**
 * A decoded file download message.
 * This message is the preamble to a file download.
 * A client downloads a file from a server, and a server downloads a file from a client.
 * @note Sending from remote to local (if exists)
 */
export type DecodedFileDownload = {
  type: "file-download";
  /**
   * The fileId (merkle root hash) of the file to download.
   */
  fileId: string;
};

/**
 * A decoded file progress message.
 */
export type DecodedFilePart = {
  type: "file-part";
  /**
   * Client-generated UUID identifying this file transfer
   */
  fileId: string;
  /**
   * Zero-based index of this chunk
   */
  chunkIndex: number;
  /**
   * Chunk data (64KB)
   */
  chunkData: Uint8Array;
  /**
   * Merkle proof path for this chunk
   */
  merkleProof: Uint8Array[];
  /**
   * Total number of chunks in the file
   */
  totalChunks: number;
  /**
   * Total bytes uploaded so far
   */
  bytesUploaded: number;
  /**
   * Whether the file is encrypted
   */
  encrypted: boolean;
};

/**
 * A decoded file auth message.
 */
export type DecodedFileAuthMessage = {
  type: "file-auth-message";
  /**
   * The permission granted or denied for the file
   */
  permission: "denied";
  /**
   * The fileId of the file that was denied authorization for
   */
  fileId: string;
  /**
   * The reason for the authorization denial
   */
  reason?: string;
  /**
   * The HTTP status code of the response
   */
  statusCode: 404 | 403 | 401 | 500 | 501;
};

/**
 * A {@link MilestoneSnapshot} is a binary encoded snapshot of a document at a point in time.
 */
export type MilestoneSnapshot = Tag<Uint8Array, "milestone-snapshot">;

/**
 * An encoded {@link MilestoneListRequest} message.
 */
export type MilestoneListRequest = Tag<Uint8Array, "milestone-list-request">;

/**
 * A decoded {@link MilestoneListRequest} message.
 * Includes a list of snapshot IDs so the response can send only milestones that are not already known.
 */
export type DecodedMilestoneListRequest = {
  type: "milestone-list-request";
  /**
   * List of snapshot IDs that the client already knows.
   * The server should only send milestones that are not in this list.
   */
  snapshotIds: string[];
};

/**
 * An encoded {@link DecodedMilestoneListResponse} message.
 */
export type MilestoneListResponse = Tag<Uint8Array, "milestone-list-response">;

/**
 * A decoded {@link MilestoneListResponse} message.
 */
export type DecodedMilestoneListResponse = {
  type: "milestone-list-response";
  milestones: Array<{
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
  }>;
};

/**
 * An encoded {@link MilestoneSnapshotRequest} message.
 */
export type MilestoneSnapshotRequest = Tag<
  Uint8Array,
  "milestone-snapshot-request"
>;

/**
 * A decoded {@link MilestoneSnapshotRequest} message.
 */
export type DecodedMilestoneSnapshotRequest = {
  type: "milestone-snapshot-request";
  milestoneId: string;
};

/**
 * An encoded {@link MilestoneSnapshotResponse} message.
 */
export type MilestoneSnapshotResponse = Tag<
  Uint8Array,
  "milestone-snapshot-response"
>;

/**
 * A decoded {@link MilestoneSnapshotResponse} message.
 */
export type DecodedMilestoneSnapshotResponse = {
  type: "milestone-snapshot-response";
  milestoneId: string;
  snapshot: MilestoneSnapshot;
};

/**
 * An encoded {@link MilestoneCreateRequest} message.
 */
export type MilestoneCreateRequest = Tag<
  Uint8Array,
  "milestone-create-request"
>;

/**
 * A decoded {@link MilestoneCreateRequest} message.
 */
export type DecodedMilestoneCreateRequest = {
  type: "milestone-create-request";
  name?: string;
};

/**
 * An encoded {@link MilestoneCreateResponse} message.
 */
export type MilestoneCreateResponse = Tag<
  Uint8Array,
  "milestone-create-response"
>;

/**
 * A decoded {@link MilestoneCreateResponse} or {@link MilestoneUpdateNameResponse} message.
 */
export type DecodedMilestoneResponse = {
  type: "milestone-create-response" | "milestone-update-name-response";
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
  };
};

/**
 * An encoded {@link MilestoneUpdateNameRequest} message.
 */
export type MilestoneUpdateNameRequest = Tag<
  Uint8Array,
  "milestone-update-name-request"
>;

/**
 * A decoded {@link MilestoneUpdateNameRequest} message.
 */
export type DecodedMilestoneUpdateNameRequest = {
  type: "milestone-update-name-request";
  milestoneId: string;
  name: string;
};

/**
 * An encoded {@link MilestoneUpdateNameResponse} message.
 */
export type MilestoneUpdateNameResponse = Tag<
  Uint8Array,
  "milestone-update-name-response"
>;

/**
 * An encoded {@link MilestoneAuthMessage} message.
 */
export type MilestoneAuthMessage = Tag<Uint8Array, "milestone-auth-message">;

/**
 * A decoded {@link MilestoneAuthMessage} message.
 */
export type DecodedMilestoneAuthMessage = {
  type: "milestone-auth-message";
  permission: "denied";
  reason: string;
};
