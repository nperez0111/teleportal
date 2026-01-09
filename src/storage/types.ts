import type {
  Milestone,
  MilestoneSnapshot,
  StateVector,
  SyncStep2Update,
  Update,
} from "teleportal";
import type { MerkleTree } from "teleportal/merkle-tree";

/**
 * Progress information for an ongoing upload
 */
export interface UploadProgress {
  /**
   * File metadata
   */
  metadata: FileMetadata;
  /**
   * Map of chunk index to whether the chunk has been uploaded
   */
  chunks: Map<number, boolean>;
  /**
   * Merkle tree for the file
   */
  merkleTree: MerkleTree | null;
  /**
   * Total bytes uploaded so far
   */
  bytesUploaded: number;
  /**
   * Timestamp of last activity
   */
  lastActivity: number;
}

/**
 * Result of completing an upload, containing all information needed to move
 * the file from temporary storage to durable storage.
 */
export interface FileUploadResult {
  /**
   * The final upload progress.
   */
  progress: UploadProgress;
  /**
   * The computed fileId (merkle root hash).
   */
  fileId: File["id"];
  /**
   * The contentId (merkle root hash as Uint8Array).
   */
  contentId: Uint8Array;
  /**
   * Retrieve a chunk for the upload by chunk index.
   * Chunks can only be fetched once and are deleted after fetching.
   */
  getChunk: (chunkIndex: number) => Promise<Uint8Array>;
}

/**
 * Interface for upload storage operations (temporary storage)
 */
export interface TemporaryUploadStorage {
  /**
   * The type of the storage.
   */
  readonly type: "temporary-upload-storage";

  /**
   * Initiate a new file upload session.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @param metadata - File metadata
   */
  beginUpload(uploadId: string, metadata: FileMetadata): Promise<void>;

  /**
   * Store a chunk for an ongoing upload.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @param chunkIndex - Zero-based index of the chunk
   * @param chunkData - Chunk data (64KB)
   * @param proof - Merkle proof for this chunk
   */
  storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void>;

  /**
   * Get upload progress for a file.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @returns Upload progress or null if not found
   */
  getUploadProgress(uploadId: string): Promise<UploadProgress | null>;

  /**
   * Complete an upload and store the file by contentId.
   * @note at this point, the upload is complete and can be stored in the file storage.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @param fileId - Optional merkle root hash (contentId). If not provided, it will be computed from the chunks.
   * @returns The final upload progress and a function to retrieve a chunk for the upload by chunk index. This allows rebuilding the whole file from the chunks to move it into a cold-storage.
   */
  completeUpload(
    uploadId: string,
    fileId?: File["id"],
  ): Promise<FileUploadResult>;

  /**
   * Clean up expired upload sessions.
   * Should remove uploads that haven't been updated within the timeout window.
   */
  cleanupExpiredUploads(): Promise<void>;
}

/**
 * Metadata for a file upload
 */
export interface FileMetadata {
  /**
   * Original filename
   */
  filename: string;
  /**
   * File size in bytes
   */
  size: number;
  /**
   * MIME type
   */
  mimeType: string;
  /**
   * Whether the file is encrypted
   */
  encrypted: boolean;
  /**
   * Last modified timestamp of the file
   */
  lastModified: number;
  /**
   * The document ID associated with this file
   */
  documentId: string;
}

/**
 * Complete file data stored by contentId
 */
export interface File {
  /**
   * The ID of the file (the same as the contentId, but as a string)
   * This is used to identify the file in the file storage.
   */
  id: string;
  /**
   * File metadata
   */
  metadata: FileMetadata;
  /**
   * All chunks in order
   */
  chunks: Uint8Array[];
  /**
   * Merkle tree root hash (contentId)
   */
  contentId: Uint8Array;
}

/**
 * Interface for updating document metadata when files are stored.
 * This allows FileStorage to update document metadata without creating
 * a circular dependency with DocumentStorage.
 */
export interface DocumentMetadataUpdater {
  /**
   * Add a file ID to a document's metadata.
   * This should be called within a transaction to ensure atomicity.
   *
   * @param documentId - The document ID
   * @param fileId - The file ID to add
   */
  addFileToDocument(documentId: Document["id"], fileId: string): Promise<void>;

  /**
   * Remove a file ID from a document's metadata.
   * This should be called within a transaction to ensure atomicity.
   *
   * @param documentId - The document ID
   * @param fileId - The file ID to remove
   */
  removeFileFromDocument(documentId: Document["id"], fileId: string): Promise<void>;
}

export interface FileStorage {
  /**
   * The type of the storage.
   */
  readonly type: "file-storage";

  /**
   * Optional temporary upload storage for this document.
   * If not provided, uploads will be done in memory only.
   */
  temporaryUploadStorage?: TemporaryUploadStorage;

  /**
   * Get a file by fileId.
   *
   * @param fileId - The ID of the file
   * @returns File data or null if not found
   */
  getFile(fileId: File["id"]): Promise<File | null>;

  /**
   * Delete a file by fileId.
   * If the file is part of any milestone, it will only be removed from the document metadata,
   * not actually deleted, so it can still be accessed from previous milestones.
   *
   * @param fileId - The ID of the file
   */
  deleteFile(fileId: File["id"]): Promise<void>;

  /**
   * Get all files associated with a document.
   *
   * @param documentId - The document ID
   * @returns Array of file data
   */
  listFileMetadataByDocument(
    documentId: Document["id"],
  ): Promise<FileMetadata[]>;

  /**
   * Delete all files associated with a document.
   *
   * @param documentId - The document ID
   */
  deleteFilesByDocument(documentId: Document["id"]): Promise<void>;

  /**
   * Store a file incrementally using the result from completeUpload.
   * This allows moving large files from temporary storage to durable storage
   * without loading the entire file into memory.
   *
   * @param uploadResult - The result from TemporaryUploadStorage.completeUpload
   */
  storeFileFromUpload(uploadResult: FileUploadResult): Promise<void>;
}

/**
 * Long-term storage for milestones both {@link Milestone} and {@link MilestoneSnapshot} are stored.
 */
export interface MilestoneStorage {
  /**
   * The type of the storage.
   */
  readonly type: "milestone-storage";

  /**
   * Store a milestone into storage
   * @returns the ID of the created milestone
   */
  createMilestone(ctx: {
    name: string;
    documentId: Document["id"];
    createdAt: number;
    snapshot: MilestoneSnapshot;
  }): Promise<string>;

  /**
   * Pull a milestone from storage
   */
  getMilestone(
    documentId: Document["id"],
    id: Milestone["id"],
  ): Promise<Milestone | null>;

  /**
   * Return the available milestones for a documentId (likely unloaded and metadata-only)
   */
  getMilestones(documentId: Document["id"]): Promise<Milestone[]>;

  /**
   * Delete the specified milestones
   */
  deleteMilestone(
    documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
  ): Promise<void>;

  /**
   * Update the name of a milestone
   */
  updateMilestoneName(
    documentId: Document["id"],
    id: Milestone["id"],
    name: string,
  ): Promise<void>;
}

/**
 * Metadata for a document.
 */
export interface DocumentMetadata {
  /**
   * Content IDs of files associated with this document
   */
  files?: string[];

  /**
   * IDs of milestones associated with this document
   */
  milestones?: string[];

  /**
   * Timestamp of creation
   */
  createdAt: number;

  /**
   * Timestamp of last update
   */
  updatedAt: number;

  /**
   * Whether the document is encrypted
   */
  encrypted: boolean;

  /**
   * Any additional metadata
   */
  [key: string]: unknown;
}

/**
 * A document is a container for a document's metadata, content, and state.
 */
export interface Document {
  /**
   * The ID of the document
   */
  id: string;

  /**
   * The metadata of the document
   */
  metadata: DocumentMetadata;

  /**
   * The content of the document
   */
  content: {
    /**
     * The most recent update of the document
     */
    update: Update;
    /**
     * The most recent state vector of the document
     */
    stateVector: StateVector;
  };
}

/**
 * A storage interface for a document.
 */
export interface DocumentStorage extends DocumentMetadataUpdater {
  /**
   * The type of the storage.
   */
  readonly type: "document-storage";

  /**
   * Optional file storage for this document.
   * If not provided, file operations will be rejected.
   */
  fileStorage?: FileStorage;

  /**
   * Optional milestone storage for this document.
   * If not provided, milestone operations will be rejected.
   */
  milestoneStorage?: MilestoneStorage;

  /**
   * Whether the storage can store encrypted documents.
   */
  storageType: "encrypted" | "unencrypted";

  /**
   * Implements synchronization with a client's state vector.
   */
  handleSyncStep1(
    documentId: Document["id"],
    syncStep1: StateVector,
  ): Promise<Document>;

  /**
   * Implements synchronization with a client's state vector.
   */
  handleSyncStep2(
    documentId: Document["id"],
    syncStep2: SyncStep2Update,
  ): Promise<void>;

  /**
   * Handles an update for a document.
   */
  handleUpdate(documentId: Document["id"], update: Update): Promise<void>;

  /**
   * Fetches the update and computes a state vector for a document.
   */
  getDocument(documentId: Document["id"]): Promise<Document | null>;

  /**
   * Stores document metadata.
   */
  writeDocumentMetadata(
    documentId: Document["id"],
    metadata: DocumentMetadata,
  ): Promise<void>;

  /**
   * Fetches document metadata.
   */
  getDocumentMetadata(documentId: Document["id"]): Promise<DocumentMetadata>;

  /**
   * Deletes a document and its associated data (metadata, files, etc).
   */
  deleteDocument(documentId: Document["id"]): Promise<void>;

  /**
   * Performs a transaction on the document. Allowing multiple operations to be performed atomically.
   * @param documentId - The ID of the document
   * @param cb - The callback to execute
   * @returns The result of the transaction
   */
  transaction<T>(documentId: Document["id"], cb: () => Promise<T>): Promise<T>;
}
