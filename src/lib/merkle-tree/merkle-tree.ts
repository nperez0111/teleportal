import { digest } from "lib0/hash/sha256";

/**
 * Size of each chunk in bytes (64KB)
 */
export const CHUNK_SIZE = 64 * 1024;

/**
 * A node in the merkle tree
 */
export interface MerkleNode {
  /**
   * Hash of this node
   */
  hash: Uint8Array;
  /**
   * Index of left child (if internal node)
   */
  left?: number;
  /**
   * Index of right child (if internal node)
   */
  right?: number;
  /**
   * Index of parent node
   */
  parent?: number;
}

/**
 * A merkle tree structure
 */
export interface MerkleTree {
  /**
   * Array of nodes in breadth-first order
   */
  nodes: MerkleNode[];
  /**
   * Number of leaf nodes (chunks)
   */
  leafCount: number;
}

/**
 * Hash two hashes together to create a parent hash
 */
function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return digest(combined);
}

/**
 * Build a merkle tree from file chunks.
 * Uses SHA-256 for hashing and creates a binary tree structure.
 *
 * @param chunks - Array of 64KB chunks
 * @returns The merkle tree
 */
export function buildMerkleTree(chunks: Uint8Array[]): MerkleTree {
  if (chunks.length === 0) {
    throw new Error("Cannot build merkle tree from empty chunks array");
  }

  const nodes: MerkleNode[] = [];
  const leafCount = chunks.length;

  // Create leaf nodes (hash each chunk)
  for (const chunk of chunks) {
    nodes.push({
      hash: digest(chunk),
    });
  }

  // Build internal nodes bottom-up (breadth-first)
  let currentLevelStart = 0;
  let currentLevelEnd = nodes.length;

  while (currentLevelEnd - currentLevelStart > 1) {
    const nextLevelStart = currentLevelEnd;
    const nextLevelEnd = nextLevelStart;

    // Process pairs of nodes at current level
    for (let i = currentLevelStart; i < currentLevelEnd; i += 2) {
      const leftNode = nodes[i];
      const rightNode = i + 1 < currentLevelEnd ? nodes[i + 1] : leftNode; // Use left node as right if odd number

      const parentHash = hashPair(leftNode.hash, rightNode.hash);
      const parentIndex = nodes.length;

      const parentNode: MerkleNode = {
        hash: parentHash,
        left: i,
        right: i + 1 < currentLevelEnd ? i + 1 : i,
      };

      nodes.push(parentNode);

      // Update parent references
      leftNode.parent = parentIndex;
      if (i + 1 < currentLevelEnd) {
        rightNode.parent = parentIndex;
      }
    }

    currentLevelStart = nextLevelStart;
    currentLevelEnd = nodes.length;
  }

  return {
    nodes,
    leafCount,
  };
}

/**
 * Generate a merkle proof for a specific chunk.
 * The proof is an array of sibling hashes needed to verify the chunk.
 *
 * @param tree - The merkle tree
 * @param chunkIndex - Zero-based index of the chunk
 * @returns Array of hashes representing the proof path
 */
export function generateMerkleProof(
  tree: MerkleTree,
  chunkIndex: number,
): Uint8Array[] {
  if (chunkIndex < 0 || chunkIndex >= tree.leafCount) {
    throw new Error(
      `Chunk index ${chunkIndex} out of range [0, ${tree.leafCount})`,
    );
  }

  const proof: Uint8Array[] = [];
  let currentNodeIndex = chunkIndex;

  while (tree.nodes[currentNodeIndex].parent !== undefined) {
    const parentIndex = tree.nodes[currentNodeIndex].parent!;
    const parent = tree.nodes[parentIndex];

    // Add sibling hash to proof
    if (parent.left === currentNodeIndex) {
      // Current node is left child, add right sibling
      const rightSiblingIndex = parent.right!;
      proof.push(tree.nodes[rightSiblingIndex].hash);
    } else {
      // Current node is right child, add left sibling
      const leftSiblingIndex = parent.left!;
      proof.push(tree.nodes[leftSiblingIndex].hash);
    }

    currentNodeIndex = parentIndex;
  }

  return proof;
}

/**
 * Verify a chunk against a merkle root using a proof.
 *
 * @param chunk - The chunk data to verify
 * @param proof - Array of sibling hashes from the proof path
 * @param root - The expected merkle root hash
 * @param index - Zero-based index of the chunk
 * @returns True if the chunk is valid, false otherwise
 */
export function verifyMerkleProof(
  chunk: Uint8Array,
  proof: Uint8Array[],
  root: Uint8Array,
  index: number,
): boolean {
  // Hash the chunk to get the leaf hash
  let currentHash = digest(chunk) as Uint8Array;

  // Traverse up the tree using the proof
  let currentIndex = index;
  for (const siblingHash of proof) {
    // Determine if current node is left or right child
    if (currentIndex % 2 === 0) {
      // Current is left child, hash with right sibling
      currentHash = hashPair(currentHash, siblingHash);
    } else {
      // Current is right child, hash with left sibling
      currentHash = hashPair(siblingHash, currentHash);
    }
    // Move to parent level
    currentIndex = Math.floor(currentIndex / 2);
  }

  // Compare final hash with root
  return (
    currentHash.length === root.length &&
    currentHash.every((byte, i) => byte === root[i])
  );
}

/**
 * Serialize a merkle tree to a Uint8Array.
 * Stores nodes in breadth-first order for efficient reconstruction.
 *
 * @param tree - The merkle tree to serialize
 * @returns Serialized tree data
 */
export function serializeMerkleTree(tree: MerkleTree): Uint8Array {
  // Each node: 32 bytes (SHA-256 hash) + 4 bytes (parent index, -1 if none)
  // Format: [leafCount (4 bytes)] [node1_hash (32 bytes)] [node1_parent (4 bytes)] ...
  const nodeSize = 32 + 4; // hash + parent index
  const totalSize = 4 + tree.nodes.length * nodeSize;
  const buffer = new Uint8Array(totalSize);

  // Write leaf count (4 bytes)
  const view = new DataView(buffer.buffer);
  view.setUint32(0, tree.leafCount, true); // little-endian

  // Write each node
  let offset = 4;
  for (const node of tree.nodes) {
    // Write hash (32 bytes)
    buffer.set(node.hash, offset);
    offset += 32;

    // Write parent index (4 bytes, -1 if none)
    const parentIndex = node.parent !== undefined ? node.parent : 0xffffffff;
    view.setUint32(offset, parentIndex, true);
    offset += 4;
  }

  return buffer;
}

/**
 * Deserialize a merkle tree from a Uint8Array.
 * Reconstructs the tree from breadth-first serialized data.
 *
 * @param data - Serialized tree data
 * @param chunkCount - Number of chunks (leaf nodes)
 * @returns The reconstructed merkle tree
 */
export function deserializeMerkleTree(
  data: Uint8Array,
  chunkCount: number,
): MerkleTree {
  const view = new DataView(data.buffer);
  const nodeSize = 32 + 4; // hash + parent index

  // Read leaf count (should match chunkCount)
  const storedLeafCount = view.getUint32(0, true);
  if (storedLeafCount !== chunkCount) {
    throw new Error(
      `Stored leaf count ${storedLeafCount} does not match chunk count ${chunkCount}`,
    );
  }

  const nodes: MerkleNode[] = [];
  let offset = 4;

  // Read all nodes
  while (offset < data.length) {
    // Read hash (32 bytes)
    const hash = data.slice(offset, offset + 32);
    offset += 32;

    // Read parent index (4 bytes)
    const parentIndex = view.getUint32(offset, true);
    offset += 4;

    const node: MerkleNode = {
      hash,
    };

    if (parentIndex !== 0xffffffff) {
      node.parent = parentIndex;
    }

    nodes.push(node);
  }

  // Reconstruct parent-child relationships
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.parent !== undefined) {
      const parent = nodes[node.parent];
      if (parent.left === undefined) {
        parent.left = i;
      } else {
        parent.right = i;
      }
    }
  }

  return {
    nodes,
    leafCount: chunkCount,
  };
}
