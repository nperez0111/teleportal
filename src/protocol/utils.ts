import type {
  StateVector,
  Update,
  DecodedBlobPartMessage,
  DecodedRequestBlobMessage,
  DecodedBlobMessage,
} from "./types";
import { BlobMessage } from "./message-types";
import { digest } from "lib0/hash/sha256";
import { toBase64 } from "lib0/buffer";
import {
  generateMerkleContentId,
  buildMerkleTreeMetadata,
  verifyMerkleTree,
  createMerkleTreeSegments,
  reconstructMerkleTreeFromSegments,
  type MerkleTreeMetadata,
} from "./merkle-tree";

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

/**
 * Maximum size for each binary upload segment (4MB)
 */
export const MAX_SEGMENT_SIZE = 4 * 1024 * 1024; // 4MB

/**
 * Generate a content-based file ID using merkle tree root hash
 * This replaces the simple SHA-256 approach with BLAKE3-style merkle tree hashing
 */
export function generateContentId(fileData: Uint8Array): string {
  return generateMerkleContentId(fileData);
}

/**
 * Legacy SHA-256 content ID generation for backward compatibility
 * @deprecated Use generateContentId instead for new implementations
 */
export function generateLegacyContentId(fileData: Uint8Array): string {
  const hash = digest(fileData);
  return toBase64(hash);
}

/**
 * Segment a large file into 4MB chunks for upload with merkle tree metadata
 */
export function segmentFileForUpload(
  fileData: Uint8Array,
  name: string,
  contentType: string,
  documentId?: string,
): BlobMessage<Record<string, unknown>>[] {
  const segments: BlobMessage<Record<string, unknown>>[] = [];
  const totalSegments = Math.ceil(fileData.length / MAX_SEGMENT_SIZE);
  const contentId = generateContentId(fileData);
  
  // Build merkle tree metadata for the entire file
  const merkleMetadata = buildMerkleTreeMetadata(fileData);
  const merkleTreeSegments = createMerkleTreeSegments(fileData, MAX_SEGMENT_SIZE);

  for (let i = 0; i < totalSegments; i++) {
    const start = i * MAX_SEGMENT_SIZE;
    const end = Math.min(start + MAX_SEGMENT_SIZE, fileData.length);
    const segmentData = fileData.slice(start, end);
    
    // Get corresponding merkle tree segment
    const merkleSegment = merkleTreeSegments[i];

    const payload: DecodedBlobPartMessage = {
      type: "blob-part",
      segmentIndex: i,
      totalSegments,
      contentId,
      name,
      contentType,
      data: segmentData,
      // Add merkle tree metadata
      merkleRootHash: merkleMetadata.rootHash,
      merkleTreeDepth: merkleMetadata.treeDepth,
      merkleChunkHashes: merkleSegment.chunkHashes,
      startChunkIndex: merkleSegment.startChunkIndex,
      endChunkIndex: merkleSegment.endChunkIndex,
    };

    segments.push(new BlobMessage(documentId || "", payload));
  }

  return segments;
}

/**
 * Check if a file needs to be segmented (larger than 4MB)
 */
export function needsSegmentation(fileSize: number): boolean {
  return fileSize > MAX_SEGMENT_SIZE;
}

/**
 * Get the number of segments needed for a file
 */
export function getSegmentCount(fileSize: number): number {
  return Math.ceil(fileSize / MAX_SEGMENT_SIZE);
}

/**
 * Reconstruct a file from its segments
 */
export function reconstructFileFromSegments(
  segments: BlobMessage<Record<string, unknown>>[],
): Uint8Array | null {
  if (segments.length === 0) return null;

  // Sort segments by index to ensure correct order
  const sortedSegments = segments
    .filter((segment) => segment.payload.type === "blob-part")
    .sort((a, b) => {
      if (a.payload.type === "blob-part" && b.payload.type === "blob-part") {
        return a.payload.segmentIndex - b.payload.segmentIndex;
      }
      return 0;
    });

  if (sortedSegments.length === 0) return null;

  // Calculate total size
  let totalSize = 0;
  for (const segment of sortedSegments) {
    if (segment.payload.type === "blob-part") {
      totalSize += segment.payload.data.length;
    }
  }

  // Reconstruct the file
  const reconstructed = new Uint8Array(totalSize);
  let offset = 0;

  for (const segment of sortedSegments) {
    if (segment.payload.type === "blob-part") {
      reconstructed.set(segment.payload.data, offset);
      offset += segment.payload.data.length;
    }
  }

  return reconstructed;
}

/**
 * Verify content integrity using merkle tree verification
 * This replaces simple content ID comparison with comprehensive merkle tree verification
 */
export function verifyContentIntegrity(
  segments: BlobMessage<Record<string, unknown>>[],
): boolean {
  if (segments.length === 0) return false;

  // Get the content ID from the first segment
  const firstSegment = segments.find(
    (segment) => segment.payload.type === "blob-part",
  );
  if (!firstSegment || firstSegment.payload.type !== "blob-part") return false;

  const expectedContentId = firstSegment.payload.contentId;
  const expectedRootHash = firstSegment.payload.merkleRootHash;

  // Verify all segments have the same content ID and merkle root hash
  for (const segment of segments) {
    if (segment.payload.type === "blob-part") {
      if (segment.payload.contentId !== expectedContentId) {
        return false;
      }
      
      // If merkle tree metadata is available, verify it matches
      if (expectedRootHash && segment.payload.merkleRootHash !== expectedRootHash) {
        return false;
      }
    }
  }

  // If we have merkle tree metadata, verify the reconstructed file against it
  if (expectedRootHash) {
    const reconstructed = reconstructFileFromSegments(segments);
    if (!reconstructed) return false;

    // Build expected merkle metadata from first segment
    const firstPayload = firstSegment.payload;
    if (firstPayload.merkleTreeDepth && firstPayload.merkleRootHash) {
      const expectedMetadata: MerkleTreeMetadata = {
        rootHash: firstPayload.merkleRootHash,
        totalChunks: 0, // Will be calculated during verification
        treeDepth: firstPayload.merkleTreeDepth,
        fileSize: reconstructed.length,
        leafHashes: [], // Will be reconstructed during verification
      };

      return verifyMerkleTree(reconstructed, expectedMetadata);
    }
  }

  return true;
}

/**
 * Verify merkle tree integrity for segments
 */
export function verifyMerkleTreeIntegrity(
  segments: BlobMessage<Record<string, unknown>>[],
): boolean {
  if (segments.length === 0) return false;

  const reconstructed = reconstructFileFromSegments(segments);
  if (!reconstructed) return false;

  // Extract merkle tree segments
  const merkleSegments = segments
    .filter((segment) => segment.payload.type === "blob-part")
    .map((segment) => {
      const payload = segment.payload as DecodedBlobPartMessage;
      return {
        segmentIndex: payload.segmentIndex,
        totalSegments: payload.totalSegments,
        merkleMetadata: {
          rootHash: payload.merkleRootHash || "",
          totalChunks: 0,
          treeDepth: payload.merkleTreeDepth || 0,
          fileSize: reconstructed.length,
          leafHashes: [],
        },
        chunkHashes: payload.merkleChunkHashes || [],
        startChunkIndex: payload.startChunkIndex || 0,
        endChunkIndex: payload.endChunkIndex || 0,
      };
    });

  const metadata = reconstructMerkleTreeFromSegments(merkleSegments);
  if (!metadata) return false;

  return verifyMerkleTree(reconstructed, metadata);
}

/**
 * Generate a unique request ID for blob requests
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a request blob message
 */
export function createRequestBlob(
  contentId: string,
  name?: string,
): BlobMessage<Record<string, unknown>> {
  const payload: DecodedRequestBlobMessage = {
    type: "request-blob",
    requestId: generateRequestId(),
    contentId,
    name,
  };

  return new BlobMessage("", payload);
}

/**
 * Get file metadata from segments
 */
export function getFileMetadata(
  segments: BlobMessage<Record<string, unknown>>[],
): {
  name: string;
  contentType: string;
  contentId: string;
  documentId?: string;
  totalSegments: number;
  totalSize: number;
  merkleRootHash?: string;
  merkleTreeDepth?: number;
} | null {
  if (segments.length === 0) return null;

  const firstSegment = segments.find(
    (segment) => segment.payload.type === "blob-part",
  );
  if (!firstSegment || firstSegment.payload.type !== "blob-part") return null;

  let totalSize = 0;
  for (const segment of segments) {
    if (segment.payload.type === "blob-part") {
      totalSize += segment.payload.data.length;
    }
  }

  return {
    name: firstSegment.payload.name,
    contentType: firstSegment.payload.contentType,
    contentId: firstSegment.payload.contentId,
    totalSegments: firstSegment.payload.totalSegments,
    totalSize,
    merkleRootHash: firstSegment.payload.merkleRootHash,
    merkleTreeDepth: firstSegment.payload.merkleTreeDepth,
  };
}
