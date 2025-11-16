import { digest } from "lib0/hash/sha256";

/**
 * Size of each chunk in bytes (64KB).
 */
export const CHUNK_SIZE = 64 * 1024;

/**
 * A node in a merkle tree.
 */
export interface MerkleNode {
  hash: Uint8Array;
  left?: MerkleNode;
  right?: MerkleNode;
  parent?: MerkleNode;
}

/**
 * A merkle tree structure.
 */
export interface MerkleTree {
  nodes: MerkleNode[];
  root: MerkleNode;
  chunkCount: number;
}

/**
 * Hash two hashes together to create a parent hash.
 */
function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return digest(combined);
}

/**
 * Build a full binary merkle tree from chunks using SHA-256.
 * @param chunks - Array of 64KB chunks
 * @returns The merkle tree
 */
export function buildMerkleTree(chunks: Uint8Array[]): MerkleTree {
  if (chunks.length === 0) {
    throw new Error("Cannot build merkle tree from empty chunks array");
  }

  // Hash each chunk to create leaf nodes
  const leafNodes: MerkleNode[] = chunks.map((chunk) => ({
    hash: digest(chunk),
  }));

  // Build tree bottom-up
  let currentLevel: MerkleNode[] = leafNodes;
  const allNodes: MerkleNode[] = [...leafNodes];

  while (currentLevel.length > 1) {
    const nextLevel: MerkleNode[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right =
        i + 1 < currentLevel.length
          ? currentLevel[i + 1]
          : left; // Duplicate last node if odd number

      const parentHash =
        i + 1 < currentLevel.length
          ? hashPair(left.hash, right.hash)
          : hashPair(left.hash, left.hash); // Self-hash if odd

      const parent: MerkleNode = {
        hash: parentHash,
        left,
        right: i + 1 < currentLevel.length ? right : undefined,
      };

      left.parent = parent;
      if (right && right !== left) {
        right.parent = parent;
      }

      nextLevel.push(parent);
      allNodes.push(parent);
    }

    currentLevel = nextLevel;
  }

  const root = currentLevel[0];

  return {
    nodes: allNodes,
    root,
    chunkCount: chunks.length,
  };
}

/**
 * Generate a merkle proof path for a chunk at the given index.
 * @param tree - The merkle tree
 * @param chunkIndex - The index of the chunk (0-based)
 * @returns Array of hashes representing the proof path from leaf to root
 */
export function generateMerkleProof(
  tree: MerkleTree,
  chunkIndex: number,
): Uint8Array[] {
  if (chunkIndex < 0 || chunkIndex >= tree.chunkCount) {
    throw new Error(
      `Chunk index ${chunkIndex} out of range [0, ${tree.chunkCount})`,
    );
  }

  const proof: Uint8Array[] = [];
  let currentNode = tree.nodes[chunkIndex]; // Leaf node

  while (currentNode.parent) {
    const parent = currentNode.parent;
    const sibling =
      parent.left === currentNode ? parent.right : parent.left;

    if (sibling) {
      proof.push(sibling.hash);
    } else {
      // If no sibling (odd number case), use the node itself
      proof.push(currentNode.hash);
    }

    currentNode = parent;
  }

  return proof;
}

/**
 * Verify a chunk against a merkle root using a proof.
 * @param chunk - The chunk data to verify
 * @param proof - The merkle proof path
 * @param root - The expected root hash
 * @param index - The index of the chunk in the original file
 * @returns True if the chunk is valid
 */
export function verifyMerkleProof(
  chunk: Uint8Array,
  proof: Uint8Array[],
  root: Uint8Array,
  index: number,
): boolean {
  let currentHash = digest(chunk);
  let currentIndex = index;

  for (const proofHash of proof) {
    if (currentIndex % 2 === 0) {
      // Current node is left child
      currentHash = hashPair(currentHash, proofHash);
    } else {
      // Current node is right child
      currentHash = hashPair(proofHash, currentHash);
    }
    currentIndex = Math.floor(currentIndex / 2);
  }

  // Compare hashes byte by byte
  if (currentHash.length !== root.length) {
    return false;
  }
  for (let i = 0; i < currentHash.length; i++) {
    if (currentHash[i] !== root[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Serialize a merkle tree as a breadth-first array of hashes.
 * This allows efficient reconstruction of the tree.
 * @param tree - The merkle tree to serialize
 * @returns Serialized tree data
 */
export function serializeMerkleTree(tree: MerkleTree): Uint8Array {
  // Use breadth-first traversal
  const queue: MerkleNode[] = [tree.root];
  const serialized: Uint8Array[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    serialized.push(node.hash);

    if (node.left) {
      queue.push(node.left);
    }
    if (node.right) {
      queue.push(node.right);
    }
  }

  // Prepend chunk count and hash size
  const hashSize = tree.root.hash.length;
  const result = new Uint8Array(
    4 + 4 + serialized.length * hashSize,
  );
  const view = new DataView(result.buffer);
  view.setUint32(0, tree.chunkCount, true); // little-endian
  view.setUint32(4, hashSize, true);
  let offset = 8;
  for (const hash of serialized) {
    result.set(hash, offset);
    offset += hashSize;
  }

  return result;
}

/**
 * Deserialize a merkle tree from serialized data.
 * @param data - Serialized tree data
 * @param chunkCount - Number of chunks (can be inferred from data, but provided for validation)
 * @returns The reconstructed merkle tree
 */
export function deserializeMerkleTree(
  data: Uint8Array,
  chunkCount: number,
): MerkleTree {
  const view = new DataView(data.buffer);
  const storedChunkCount = view.getUint32(0, true);
  const hashSize = view.getUint32(4, true);

  if (storedChunkCount !== chunkCount) {
    throw new Error(
      `Chunk count mismatch: expected ${chunkCount}, got ${storedChunkCount}`,
    );
  }

  // Extract all hashes
  const hashCount = (data.length - 8) / hashSize;
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < hashCount; i++) {
    const offset = 8 + i * hashSize;
    hashes.push(data.slice(offset, offset + hashSize));
  }

  // Reconstruct tree nodes (breadth-first)
  const nodes: MerkleNode[] = [];
  let hashIndex = 0;

  // Create all nodes first
  for (const hash of hashes) {
    nodes.push({ hash });
  }

  // Reconstruct parent-child relationships
  let nodeIndex = 0;
  const queue: MerkleNode[] = [nodes[0]]; // Start with root

  while (queue.length > 0 && nodeIndex < nodes.length) {
    const parent = queue.shift()!;
    const leftIndex = nodeIndex + 1;
    const rightIndex = nodeIndex + 2;

    if (leftIndex < nodes.length) {
      const left = nodes[leftIndex];
      parent.left = left;
      left.parent = parent;
      queue.push(left);
      nodeIndex++;

      if (rightIndex < nodes.length) {
        const right = nodes[rightIndex];
        parent.right = right;
        right.parent = parent;
        queue.push(right);
        nodeIndex++;
      }
    }
  }

  return {
    nodes,
    root: nodes[0],
    chunkCount,
  };
}
