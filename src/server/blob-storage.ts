import type {
  DecodedBlobPartMessage,
  DecodedRequestBlobMessage,
} from "../protocol/types";
import type { Logger } from "./logger";

export interface BlobStorage {
  /**
   * Store a blob part (temporarily, if incomplete)
   */
  storeBlobPart(blobPart: DecodedBlobPartMessage): Promise<void>;

  /**
   * Get all blob parts for a content ID
   * @returns `null` if the blob is not complete yet
   */
  getBlobParts(contentId: string): Promise<DecodedBlobPartMessage[] | null>;

  /**
   * Check if all parts for a blob are available
   */
  isBlobComplete(contentId: string): Promise<boolean>;

  /**
   * Remove all parts for a blob (cleanup)
   */
  removeBlob(contentId: string): Promise<void>;
}

export interface InMemoryBlobStorageOptions {
  logger: Logger;
  /**
   * Maximum time to keep incomplete blobs (in milliseconds)
   * Default: 1 hour
   */
  maxIncompleteBlobAge?: number;
  /**
   * Maximum number of incomplete blobs to store
   * Default: 1000
   */
  maxIncompleteBlobs?: number;
}

/**
 * In-memory implementation of blob storage
 */
export class InMemoryBlobStorage implements BlobStorage {
  private logger: Logger;
  private blobParts = new Map<string, Map<number, DecodedBlobPartMessage>>();
  private blobMetadata = new Map<
    string,
    {
      name: string;
      contentType: string;
      totalSegments: number;
      createdAt: number;
    }
  >();
  private maxIncompleteBlobAge: number;
  private maxIncompleteBlobs: number;

  constructor(options: InMemoryBlobStorageOptions) {
    this.logger = options.logger.withContext({ name: "blob-storage" });
    this.maxIncompleteBlobAge = options.maxIncompleteBlobAge ?? 60 * 60 * 1000; // 1 hour
    this.maxIncompleteBlobs = options.maxIncompleteBlobs ?? 1000;

    // Clean up incomplete blobs periodically
    setInterval(
      () => this.cleanupIncompleteBlobs(),
      this.maxIncompleteBlobAge / 2,
    );
  }

  async storeBlobPart(blobPart: DecodedBlobPartMessage): Promise<void> {
    const { contentId, segmentIndex } = blobPart;

    if (!this.blobParts.has(contentId)) {
      this.blobParts.set(contentId, new Map());
    }

    const parts = this.blobParts.get(contentId)!;
    parts.set(segmentIndex, blobPart);

    // Store metadata if this is the first part
    if (segmentIndex === 0) {
      this.blobMetadata.set(contentId, {
        name: blobPart.name,
        contentType: blobPart.contentType,
        totalSegments: blobPart.totalSegments,
        createdAt: Date.now(),
      });
    }

    this.logger
      .withMetadata({
        contentId,
        segmentIndex,
        dataSize: blobPart.data.length,
      })
      .trace("stored blob part");
  }

  async getBlobParts(
    contentId: string,
  ): Promise<DecodedBlobPartMessage[] | null> {
    const parts = this.blobParts.get(contentId);
    if (!parts) {
      return null;
    }

    const metadata = this.blobMetadata.get(contentId);
    if (!metadata) {
      return null;
    }

    // Check if we have all segments
    const hasAllSegments = Array.from(
      { length: metadata.totalSegments },
      (_, i) => i,
    ).every((i) => parts.has(i));

    if (!hasAllSegments) {
      return null; // Not complete yet
    }

    // Return all parts in order
    const result: DecodedBlobPartMessage[] = [];
    for (let i = 0; i < metadata.totalSegments; i++) {
      const part = parts.get(i);
      if (part) {
        result.push(part);
      }
    }

    return result;
  }

  async isBlobComplete(contentId: string): Promise<boolean> {
    const parts = this.blobParts.get(contentId);
    const metadata = this.blobMetadata.get(contentId);

    if (!parts || !metadata) {
      return false;
    }

    // Check if we have all segments from 0 to totalSegments - 1
    for (let i = 0; i < metadata.totalSegments; i++) {
      if (!parts.has(i)) {
        return false;
      }
    }

    return true;
  }

  async removeBlob(contentId: string): Promise<void> {
    this.blobParts.delete(contentId);
    this.blobMetadata.delete(contentId);

    this.logger.withMetadata({ contentId }).trace("removed blob");
  }

  private cleanupIncompleteBlobs(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [contentId, metadata] of this.blobMetadata.entries()) {
      const isComplete = this.isBlobComplete(contentId);

      if (!isComplete && now - metadata.createdAt > this.maxIncompleteBlobAge) {
        toRemove.push(contentId);
      }
    }

    // Also remove if we have too many incomplete blobs
    const incompleteBlobs = Array.from(this.blobMetadata.entries())
      .filter(([contentId]) => !this.isBlobComplete(contentId))
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    while (incompleteBlobs.length > this.maxIncompleteBlobs) {
      toRemove.push(incompleteBlobs.shift()![0]);
    }

    for (const contentId of toRemove) {
      this.removeBlob(contentId);
    }

    if (toRemove.length > 0) {
      this.logger
        .withMetadata({ count: toRemove.length })
        .info("cleaned up incomplete blobs");
    }
  }
}

/**
 * Blob storage manager that coordinates blob operations
 */
export class BlobStorageManager {
  private storage: BlobStorage;
  private logger: Logger;
  private onCompleteBlob?: (
    contentId: string,
    data: Uint8Array,
    metadata: {
      name: string;
      contentType: string;
    },
  ) => Promise<void>;
  private completedBlobs = new Set<string>();

  constructor(options: {
    storage: BlobStorage;
    logger: Logger;
    onCompleteBlob?: (
      contentId: string,
      data: Uint8Array,
      metadata: {
        name: string;
        contentType: string;
      },
    ) => Promise<void>;
  }) {
    this.storage = options.storage;
    this.logger = options.logger.withContext({ name: "blob-storage-manager" });
    this.onCompleteBlob = options.onCompleteBlob;
  }

  /**
   * Handle a blob part message
   */
  async handleBlobPart(message: DecodedBlobPartMessage): Promise<void> {
    const { contentId, segmentIndex, totalSegments, name, contentType, data } =
      message;

    this.logger
      .withMetadata({
        contentId,
        segmentIndex,
        totalSegments,
        name,
        contentType,
        dataSize: data.length,
      })
      .trace("handling blob part");

    // Store the blob part
    await this.storage.storeBlobPart(message);

    // Check if the blob is complete
    const isComplete = await this.storage.isBlobComplete(contentId);

    if (isComplete && !this.completedBlobs.has(contentId)) {
      this.completedBlobs.add(contentId);
      await this.handleCompleteBlob(contentId);
    }
  }

  /**
   * Handle a request blob message
   */
  async handleRequestBlob(message: DecodedRequestBlobMessage): Promise<{
    data: Uint8Array | null;
    metadata: {
      name: string;
      contentType: string;
      totalSegments: number;
      totalSize: number;
    } | null;
  }> {
    const { contentId } = message;

    this.logger.withMetadata({ contentId }).trace("handling request blob");

    const parts = await this.storage.getBlobParts(contentId);
    if (!parts) {
      return { data: null, metadata: null };
    }

    // Reconstruct the complete file
    const totalSize = parts.reduce((sum, part) => sum + part.data.length, 0);
    const data = new Uint8Array(totalSize);
    let offset = 0;

    for (const part of parts) {
      data.set(part.data, offset);
      offset += part.data.length;
    }

    const metadata = {
      name: parts[0].name,
      contentType: parts[0].contentType,
      totalSegments: parts[0].totalSegments,
      totalSize,
    };

    return { data, metadata };
  }

  private async handleCompleteBlob(contentId: string): Promise<void> {
    this.logger.withMetadata({ contentId }).info("blob complete");

    const parts = await this.storage.getBlobParts(contentId);
    if (!parts || parts.length === 0) {
      this.logger
        .withMetadata({ contentId })
        .error("no parts found for complete blob");
      return;
    }

    // Reconstruct the complete file
    const totalSize = parts.reduce((sum, part) => sum + part.data.length, 0);
    const data = new Uint8Array(totalSize);
    let offset = 0;

    for (const part of parts) {
      data.set(part.data, offset);
      offset += part.data.length;
    }

    // Call the completion callback
    if (this.onCompleteBlob) {
      try {
        await this.onCompleteBlob(contentId, data, {
          name: parts[0].name,
          contentType: parts[0].contentType,
        });
      } catch (error) {
        this.logger
          .withMetadata({ contentId, error })
          .error("error in onCompleteBlob callback");
      }
    }

    // Note: We don't remove the blob immediately so it can be requested
    // The cleanup process will handle removal of old blobs
  }
}
