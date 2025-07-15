import { digest } from "lib0/hash/sha256";
import { toBase64, fromBase64 } from "lib0/buffer";

/**
 * Streaming merkle tree constants
 * Using SHA-256 for hashing with streaming verification capabilities
 */
export const CHUNK_SIZE = 1024; // 1KB chunks for merkle tree nodes
export const MAX_TREE_DEPTH = 16; // Maximum tree depth

/**
 * Represents a node in the merkle tree
 */
export interface MerkleNode {
  hash: string;
  level: number;
  chunkIndex: number;
  leftChild?: MerkleNode;
  rightChild?: MerkleNode;
  isLeaf: boolean;
}

/**
 * Merkle tree metadata for a file
 */
export interface MerkleTreeMetadata {
  rootHash: string;
  totalChunks: number;
  treeDepth: number;
  fileSize: number;
  leafHashes: string[];
}

/**
 * Represents a merkle tree segment with metadata
 */
export interface MerkleTreeSegment {
  segmentIndex: number;
  totalSegments: number;
  merkleMetadata: MerkleTreeMetadata;
  chunkHashes: string[];
  startChunkIndex: number;
  endChunkIndex: number;
}

/**
 * Hash a single chunk using SHA-256 with domain separation
 */
function hashChunk(data: Uint8Array, chunkIndex: number): string {
  // Create a buffer that includes the chunk index for domain separation
  const indexBytes = new Uint8Array(8);
  const view = new DataView(indexBytes.buffer);
  view.setBigUint64(0, BigInt(chunkIndex), false); // big-endian
  
  // Combine chunk index and data
  const combined = new Uint8Array(indexBytes.length + data.length);
  combined.set(indexBytes, 0);
  combined.set(data, indexBytes.length);
  
  const hash = digest(combined);
  return toBase64(hash);
}

/**
 * Hash two child hashes together to create a parent hash
 */
function hashParent(leftHash: string, rightHash: string, level: number): string {
  // Convert base64 strings to bytes
  const leftBytes = fromBase64(leftHash);
  const rightBytes = fromBase64(rightHash);
  
  // Create level bytes for domain separation
  const levelBytes = new Uint8Array(4);
  const view = new DataView(levelBytes.buffer);
  view.setUint32(0, level, false); // big-endian
  
  // Combine level, left hash, and right hash
  const combined = new Uint8Array(levelBytes.length + leftBytes.length + rightBytes.length);
  combined.set(levelBytes, 0);
  combined.set(leftBytes, levelBytes.length);
  combined.set(rightBytes, levelBytes.length + leftBytes.length);
  
  const hash = digest(combined);
  return toBase64(hash);
}

/**
 * Split file data into chunks for merkle tree construction
 */
function chunkData(data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, data.length);
    chunks.push(data.slice(i, end));
  }
  
  // Ensure we have at least one chunk even for empty files
  if (chunks.length === 0) {
    chunks.push(new Uint8Array(0));
  }
  
  return chunks;
}

/**
 * Build a merkle tree from leaf hashes
 */
function buildMerkleTree(leafHashes: string[]): MerkleNode {
  if (leafHashes.length === 0) {
    throw new Error("Cannot build merkle tree with no leaf hashes");
  }
  
  if (leafHashes.length === 1) {
    return {
      hash: leafHashes[0],
      level: 0,
      chunkIndex: 0,
      isLeaf: true,
    };
  }
  
  // Create leaf nodes
  let currentLevel: MerkleNode[] = leafHashes.map((hash, index) => ({
    hash,
    level: 0,
    chunkIndex: index,
    isLeaf: true,
  }));
  
  let level = 1;
  
  // Build tree bottom-up
  while (currentLevel.length > 1) {
    const nextLevel: MerkleNode[] = [];
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      const leftChild = currentLevel[i];
      const rightChild = i + 1 < currentLevel.length ? currentLevel[i + 1] : leftChild;
      
      const parentHash = hashParent(leftChild.hash, rightChild.hash, level);
      
      nextLevel.push({
        hash: parentHash,
        level,
        chunkIndex: Math.floor(i / 2),
        leftChild,
        rightChild: rightChild !== leftChild ? rightChild : undefined,
        isLeaf: false,
      });
    }
    
    currentLevel = nextLevel;
    level++;
  }
  
  return currentLevel[0];
}

/**
 * Generate a content ID using merkle tree root hash
 */
export function generateMerkleContentId(data: Uint8Array): string {
  const metadata = buildMerkleTreeMetadata(data);
  return metadata.rootHash;
}

/**
 * Build complete merkle tree metadata for a file
 */
export function buildMerkleTreeMetadata(data: Uint8Array): MerkleTreeMetadata {
  const chunks = chunkData(data);
  const leafHashes = chunks.map((chunk, index) => hashChunk(chunk, index));
  
  const rootNode = buildMerkleTree(leafHashes);
  
  return {
    rootHash: rootNode.hash,
    totalChunks: chunks.length,
    treeDepth: rootNode.level + 1,
    fileSize: data.length,
    leafHashes,
  };
}

/**
 * Verify merkle tree integrity by recomputing the root hash
 */
export function verifyMerkleTree(data: Uint8Array, metadata: MerkleTreeMetadata): boolean {
  try {
    const recomputed = buildMerkleTreeMetadata(data);
    return recomputed.rootHash === metadata.rootHash &&
           recomputed.totalChunks === metadata.totalChunks &&
           recomputed.fileSize === metadata.fileSize;
  } catch {
    return false;
  }
}

/**
 * Create merkle tree segments for a large file
 */
export function createMerkleTreeSegments(
  data: Uint8Array,
  maxSegmentSize: number,
): MerkleTreeSegment[] {
  const segments: MerkleTreeSegment[] = [];
  const totalSegments = Math.ceil(data.length / maxSegmentSize);
  const chunks = chunkData(data);
  const chunksPerSegment = Math.ceil(chunks.length / totalSegments);
  
  for (let i = 0; i < totalSegments; i++) {
    const startChunkIndex = i * chunksPerSegment;
    const endChunkIndex = Math.min(startChunkIndex + chunksPerSegment, chunks.length);
    
    const segmentChunks = chunks.slice(startChunkIndex, endChunkIndex);
    const segmentData = new Uint8Array(
      segmentChunks.reduce((total, chunk) => total + chunk.length, 0)
    );
    
    let offset = 0;
    for (const chunk of segmentChunks) {
      segmentData.set(chunk, offset);
      offset += chunk.length;
    }
    
    const metadata = buildMerkleTreeMetadata(data); // Use full file for complete tree
    const chunkHashes = segmentChunks.map((chunk, index) => 
      hashChunk(chunk, startChunkIndex + index)
    );
    
    segments.push({
      segmentIndex: i,
      totalSegments,
      merkleMetadata: metadata,
      chunkHashes,
      startChunkIndex,
      endChunkIndex: endChunkIndex - 1,
    });
  }
  
  return segments;
}

/**
 * Reconstruct merkle tree metadata from segments
 */
export function reconstructMerkleTreeFromSegments(segments: MerkleTreeSegment[]): MerkleTreeMetadata | null {
  if (segments.length === 0) return null;
  
  // All segments should have the same merkle metadata for the complete file
  const firstSegment = segments[0];
  const metadata = firstSegment.merkleMetadata;
  
  // Verify all segments have consistent metadata
  for (const segment of segments) {
    if (segment.merkleMetadata.rootHash !== metadata.rootHash ||
        segment.merkleMetadata.totalChunks !== metadata.totalChunks ||
        segment.merkleMetadata.fileSize !== metadata.fileSize) {
      return null;
    }
  }
  
  return metadata;
}

/**
 * Get merkle proof for a specific chunk
 */
export function getMerkleProof(leafHashes: string[], targetChunkIndex: number): string[] {
  if (targetChunkIndex >= leafHashes.length) {
    throw new Error("Target chunk index out of bounds");
  }
  
  const proof: string[] = [];
  let currentLevel = leafHashes.slice();
  let currentIndex = targetChunkIndex;
  let level = 0;
  
  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      const leftHash = currentLevel[i];
      const rightHash = i + 1 < currentLevel.length ? currentLevel[i + 1] : leftHash;
      
      // Add sibling to proof if this is our current path
      if (i === currentIndex || i + 1 === currentIndex) {
        const siblingIndex = i === currentIndex ? i + 1 : i;
        if (siblingIndex < currentLevel.length && siblingIndex !== currentIndex) {
          proof.push(currentLevel[siblingIndex]);
        }
      }
      
      const parentHash = hashParent(leftHash, rightHash, level + 1);
      nextLevel.push(parentHash);
    }
    
    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
    level++;
  }
  
  return proof;
}

/**
 * Verify a merkle proof for a specific chunk
 */
export function verifyMerkleProof(
  chunkHash: string,
  chunkIndex: number,
  proof: string[],
  rootHash: string,
): boolean {
  try {
    let currentHash = chunkHash;
    let currentIndex = chunkIndex;
    let level = 1;
    
    for (const siblingHash of proof) {
      const isLeftChild = currentIndex % 2 === 0;
      
      if (isLeftChild) {
        currentHash = hashParent(currentHash, siblingHash, level);
      } else {
        currentHash = hashParent(siblingHash, currentHash, level);
      }
      
      currentIndex = Math.floor(currentIndex / 2);
      level++;
    }
    
    return currentHash === rootHash;
  } catch {
    return false;
  }
}