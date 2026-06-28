import { digest } from "lib0/hash/sha256";

/**
 * Size of each chunk in bytes (64KB)
 */
export const CHUNK_SIZE = 64 * 1024;

/**
 * Size of each encrypted chunk in bytes (64KB - 28 bytes for the authentication tag)
 */
export const ENCRYPTED_CHUNK_SIZE = CHUNK_SIZE - 28;

/**
 * A node in the merkle tree
 */
export interface MerkleNode {
  /**
   * Hash of this node
   */
  hash?: Uint8Array;
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
 * Hash two hashes together to create a parent hash (sync, using lib0 digest).
 * Used in verifyMerkleProof and StableIncrementalMerkleTree where async overhead
 * would outweigh the crypto speedup.
 */
function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return digest(combined);
}

/**
 * Hardware-accelerated SHA-256 digest via Web Crypto API.
 */
async function digestAsync(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}


/**
 * Build a merkle tree from file chunks.
 * Uses hardware-accelerated SHA-256 (Web Crypto) for hashing and creates a
 * binary tree structure. Leaf hashing and each level of internal node hashing
 * are parallelized via Promise.all.
 *
 * @param chunks - Array of 64KB chunks
 * @returns The merkle tree
 */
export async function buildMerkleTree(chunks: Uint8Array[]): Promise<MerkleTree> {
  if (chunks.length === 0) {
    throw new Error("Cannot build merkle tree from empty chunks array");
  }

  const nodes: MerkleNode[] = [];
  const leafCount = chunks.length;

  // Hash all leaves in parallel using hardware-accelerated SHA-256
  const leafHashes = await Promise.all(chunks.map((chunk) => digestAsync(chunk)));

  // Create leaf nodes
  for (const hash of leafHashes) {
    nodes.push({ hash });
  }

  // Build internal nodes bottom-up using sync hashing. Internal nodes hash
  // only 64 bytes (two concatenated SHA-256 digests), where the async overhead
  // of crypto.subtle.digest would far exceed the computation cost.
  let currentLevelStart = 0;
  let currentLevelEnd = nodes.length;

  while (currentLevelEnd - currentLevelStart > 1) {
    const nextLevelStart = currentLevelEnd;

    for (let i = currentLevelStart; i < currentLevelEnd; i += 2) {
      const leftNode = nodes[i];
      const rightIdx = i + 1 < currentLevelEnd ? i + 1 : i;
      const rightNode = nodes[rightIdx];

      const parentHash = hashPair(leftNode.hash!, rightNode.hash!);
      const parentIndex = nodes.length;

      const parentNode: MerkleNode = {
        hash: parentHash,
        left: i,
        right: rightIdx,
      };

      nodes.push(parentNode);

      leftNode.parent = parentIndex;
      if (rightIdx !== i) {
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

function buildMerkleStructure(leafCount: number): MerkleNode[] {
  if (leafCount === 0) {
    return [];
  }

  const nodes: MerkleNode[] = Array.from({ length: leafCount }, () => ({}) as MerkleNode);
  let currentLevelStart = 0;
  let currentLevelEnd = nodes.length;

  while (currentLevelEnd - currentLevelStart > 1) {
    const nextLevelStart = currentLevelEnd;

    for (let i = currentLevelStart; i < currentLevelEnd; i += 2) {
      const leftNode = nodes[i];
      const rightIndex = i + 1 < currentLevelEnd ? i + 1 : i;
      const rightNode = nodes[rightIndex];
      const parentIndex = nodes.length;

      const parentNode: MerkleNode = {
        left: i,
        right: rightIndex,
      };

      nodes.push(parentNode);

      leftNode.parent = parentIndex;
      rightNode.parent = parentIndex;
    }

    currentLevelStart = nextLevelStart;
    currentLevelEnd = nodes.length;
  }

  return nodes;
}

/**
 * Generate a merkle proof for a specific chunk.
 * The proof is an array of sibling hashes needed to verify the chunk.
 *
 * @param tree - The merkle tree
 * @param chunkIndex - Zero-based index of the chunk
 * @returns Array of hashes representing the proof path
 */
export function generateMerkleProof(tree: MerkleTree, chunkIndex: number): Uint8Array[] {
  if (chunkIndex < 0 || chunkIndex >= tree.leafCount) {
    throw new Error(`Chunk index ${chunkIndex} out of range [0, ${tree.leafCount})`);
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
      proof.push(tree.nodes[rightSiblingIndex].hash!);
    } else {
      // Current node is right child, add left sibling
      const leftSiblingIndex = parent.left!;
      proof.push(tree.nodes[leftSiblingIndex].hash!);
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
  return currentHash.length === root.length && currentHash.every((byte, i) => byte === root[i]);
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
    const hash = node.hash;
    if (!hash) {
      throw new Error("Cannot serialize node without hash");
    }
    buffer.set(hash, offset);
    offset += 32;

    // Write parent index (4 bytes, -1 if none)
    const parentIndex = node.parent === undefined ? 0xff_ff_ff_ff : node.parent;
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
export function deserializeMerkleTree(data: Uint8Array, chunkCount: number): MerkleTree {
  const view = new DataView(data.buffer);
  const _nodeSize = 32 + 4; // hash + parent index

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

    if (parentIndex !== 0xff_ff_ff_ff) {
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
  // Odd-level nodes duplicate left as right in buildMerkleTree
  for (const node of nodes) {
    if (node.left !== undefined && node.right === undefined) {
      node.right = node.left;
    }
  }

  return {
    nodes,
    leafCount: chunkCount,
  };
}

/**
 * Output structure for each file part from the merkle tree transform stream
 */
export interface FilePart {
  /**
   * The chunk data
   */
  chunkData: Uint8Array;
  /**
   * Zero-based index of this chunk
   */
  chunkIndex: number;
  /**
   * Merkle proof for this chunk
   */
  merkleProof: Uint8Array[];
  /**
   * Total number of chunks in the file
   */
  totalChunks: number;
  /**
   * Total bytes processed so far (including this chunk)
   */
  bytesProcessed: number;
  /**
   * The merkle root hash (content ID)
   */
  rootHash: Uint8Array;
  /**
   * Whether the file is encrypted
   */
  encrypted: boolean;
}

/**
 * Stable incremental merkle tree builder that knows the complete tree structure ahead of time.
 * Allows generating stable proofs as soon as sibling hashes are available.
 */
class StableIncrementalMerkleTree {
  private nodes: MerkleNode[];
  private chunksAdded = 0;
  private readonly leafCount: number;

  constructor(totalChunks: number) {
    this.leafCount = Math.max(1, totalChunks);
    this.nodes = buildMerkleStructure(this.leafCount);
  }

  async addChunk(chunk: Uint8Array): Promise<number> {
    if (this.chunksAdded >= this.leafCount) {
      throw new Error("Cannot add more chunks than totalChunks");
    }

    const chunkIndex = this.chunksAdded;
    const node = this.nodes[chunkIndex];
    node.hash = await digestAsync(chunk);
    this.chunksAdded++;

    this.propagateParents(chunkIndex);
    return chunkIndex;
  }

  private propagateParents(childIndex: number) {
    let currentIndex = childIndex;
    while (true) {
      const parentIndex = this.nodes[currentIndex].parent;
      if (parentIndex === undefined) {
        break;
      }

      const parent = this.nodes[parentIndex];
      const leftNode = this.nodes[parent.left!];
      const rightNode = this.nodes[parent.right!];

      if (!leftNode.hash || !rightNode.hash) {
        break;
      }

      if (!parent.hash) {
        parent.hash = hashPair(leftNode.hash, rightNode.hash);
      }

      currentIndex = parentIndex;
    }
  }

  canGenerateProof(chunkIndex: number): boolean {
    const node = this.nodes[chunkIndex];
    if (!node.hash) {
      return false;
    }

    let currentIndex = chunkIndex;
    while (true) {
      const parentIndex = this.nodes[currentIndex].parent;
      if (parentIndex === undefined) {
        break;
      }

      const parent = this.nodes[parentIndex];
      const siblingIndex = parent.left === currentIndex ? parent.right : parent.left;
      if (siblingIndex === undefined) {
        return false;
      }

      const siblingHash = this.nodes[siblingIndex].hash;
      if (!siblingHash) {
        return false;
      }

      currentIndex = parentIndex;
    }

    return true;
  }

  generateProof(chunkIndex: number): Uint8Array[] {
    if (!this.canGenerateProof(chunkIndex)) {
      throw new Error("Proof is not ready yet");
    }

    const proof: Uint8Array[] = [];
    let currentIndex = chunkIndex;
    while (true) {
      const parentIndex = this.nodes[currentIndex].parent;
      if (parentIndex === undefined) {
        break;
      }

      const parent = this.nodes[parentIndex];
      const siblingIndex = parent.left === currentIndex ? parent.right : parent.left;

      if (siblingIndex === undefined) {
        break;
      }

      const sibling = this.nodes[siblingIndex];
      if (!sibling.hash) {
        break;
      }

      proof.push(sibling.hash);
      currentIndex = parentIndex;
    }

    return proof;
  }

  getRootHash(): Uint8Array | null {
    if (this.nodes.length === 0) {
      return null;
    }

    const root = this.nodes.at(-1);
    return root?.hash ?? null;
  }

  getTotalChunks(): number {
    return this.leafCount;
  }
}

/**
 * Chunk a file stream into {@link FilePart} objects with merkle proofs.
 *
 * Reads from a {@link ReadableStream}, splits into CHUNK_SIZE pieces, builds
 * a merkle tree incrementally, and yields each part once its proof is stable.
 * The root hash is only set on the last part.
 *
 * @param source - ReadableStream of raw file bytes (e.g. from `File.stream()`)
 * @param fileSize - Total file size in bytes
 * @param encryptChunk - Optional per-chunk encryption function
 */
export async function* chunkFile(
  source: ReadableStream<Uint8Array>,
  fileSize: number,
  encryptChunk?: (chunk: Uint8Array) => Promise<Uint8Array> | Uint8Array,
): AsyncGenerator<FilePart> {
  const chunkSize = encryptChunk ? ENCRYPTED_CHUNK_SIZE : CHUNK_SIZE;
  const totalChunks = fileSize === 0 ? 1 : Math.ceil(fileSize / chunkSize);
  const tree = new StableIncrementalMerkleTree(totalChunks);
  let buffer = new Uint8Array(0);
  let bytesProcessed = 0;
  const pendingChunks = new Map<number, Uint8Array>();

  function* flushReady(): Generator<FilePart> {
    const readyIndexes: number[] = [];
    for (const [index] of pendingChunks) {
      if (tree.canGenerateProof(index)) {
        readyIndexes.push(index);
      }
    }
    for (const index of readyIndexes) {
      const data = pendingChunks.get(index)!;
      pendingChunks.delete(index);
      const proof = tree.generateProof(index);
      const rootHash =
        index === totalChunks - 1 ? (tree.getRootHash() ?? new Uint8Array(0)) : new Uint8Array(0);
      bytesProcessed += data.length;
      yield {
        chunkData: data,
        chunkIndex: index,
        merkleProof: proof,
        totalChunks,
        bytesProcessed,
        rootHash,
        encrypted: !!encryptChunk,
      };
    }
  }

  async function processChunk(raw: Uint8Array) {
    const encoded = encryptChunk ? await encryptChunk(raw) : raw;
    const chunkIndex = await tree.addChunk(encoded);
    pendingChunks.set(chunkIndex, encoded);
  }

  for await (const incoming of source) {
    const newBuffer = new Uint8Array(buffer.length + incoming.length);
    newBuffer.set(buffer, 0);
    newBuffer.set(incoming, buffer.length);
    buffer = newBuffer;

    while (buffer.length >= chunkSize) {
      await processChunk(buffer.slice(0, chunkSize));
      buffer = buffer.slice(chunkSize);
      yield* flushReady();
    }
  }

  if (buffer.length > 0) {
    await processChunk(buffer);
  } else if (totalChunks === 1 && pendingChunks.size === 0) {
    await processChunk(new Uint8Array(0));
  }

  yield* flushReady();
  yield* flushReady();
}
