import { digest } from "lib0/hash/sha256";

/**
 * Size of each chunk in bytes (1MB)
 */
export const CHUNK_SIZE = 1024 * 1024;

/**
 * AES-GCM overhead per encrypted chunk: 12-byte nonce + 16-byte auth tag.
 */
export const AES_GCM_OVERHEAD = 28;

/**
 * Size of each encrypted chunk in bytes (CHUNK_SIZE - AES_GCM_OVERHEAD)
 */
export const ENCRYPTED_CHUNK_SIZE = CHUNK_SIZE - AES_GCM_OVERHEAD;

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
  const combined = new Uint8Array(64);
  combined.set(left, 0);
  combined.set(right, 32);
  return digest(combined);
}

/**
 * Hardware-accelerated SHA-256 digest via Web Crypto API.
 */
async function digestAsync(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
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
 * Process a file into {@link FilePart} objects with merkle proofs, returning
 * all parts as an array. Encrypts and hashes all chunks in parallel using
 * `Promise.all` and builds the merkle tree in one pass.
 */
export async function processFile(
  source: ReadableStream<Uint8Array>,
  fileSize: number,
  encryptChunk?: (chunk: Uint8Array) => Promise<Uint8Array> | Uint8Array,
  targetChunkSize?: number,
): Promise<FilePart[]> {
  const wireChunkSize = targetChunkSize ?? CHUNK_SIZE;
  const chunkSize = encryptChunk ? wireChunkSize - AES_GCM_OVERHEAD : wireChunkSize;
  const encrypted = !!encryptChunk;

  // Read entire stream into a single buffer
  let buf = new Uint8Array(fileSize > 0 ? fileSize : chunkSize);
  let writePos = 0;
  for await (const incoming of source) {
    if (writePos + incoming.length > buf.length) {
      const newBuf = new Uint8Array(Math.max(buf.length * 2, writePos + incoming.length));
      newBuf.set(buf.subarray(0, writePos), 0);
      buf = newBuf;
    }
    buf.set(incoming, writePos);
    writePos += incoming.length;
  }

  const totalChunks = writePos === 0 ? 1 : Math.ceil(writePos / chunkSize);
  const rawChunks: Uint8Array[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, writePos);
    // Use subarray (zero-copy view) when encrypting — encryption produces
    // a fresh buffer anyway so the copy from slice is wasted.
    rawChunks.push(
      start < writePos
        ? encryptChunk
          ? buf.subarray(start, end)
          : buf.slice(start, end)
        : new Uint8Array(0),
    );
  }

  const encoded = encryptChunk
    ? await Promise.all(rawChunks.map((c) => encryptChunk(c)))
    : rawChunks;

  // Build merkle tree in one pass (parallel leaf hashing internally)
  const tree = await buildMerkleTree(encoded);
  const rootHash = tree.nodes.at(-1)!.hash!;

  // Generate all proofs and assemble parts
  const parts: FilePart[] = [];
  let bytesProcessed = 0;
  for (let i = 0; i < totalChunks; i++) {
    bytesProcessed += encoded[i].length;
    parts.push({
      chunkData: encoded[i],
      chunkIndex: i,
      merkleProof: generateMerkleProof(tree, i),
      totalChunks,
      bytesProcessed,
      rootHash: i === totalChunks - 1 ? rootHash : new Uint8Array(0),
      encrypted,
    });
  }

  return parts;
}

/**
 * A chunk emitted by {@link processFileStreaming}, ready to be sent.
 */
export interface StreamedFilePart {
  /** The (encrypted) chunk data to send. */
  chunkData: Uint8Array;
  /** Zero-based index of this chunk. */
  chunkIndex: number;
  /** Total number of chunks in the file. */
  totalChunks: number;
  /** Cumulative bytes emitted so far (including this chunk). */
  bytesProcessed: number;
  /** Whether the chunk is encrypted. */
  encrypted: boolean;
}

/**
 * Pipelined upload processing. Encrypts every chunk concurrently and invokes
 * `onPart` for each one the moment its ciphertext is ready — so the caller can
 * start sending while later chunks are still encrypting — then folds the merkle
 * root once all leaves are hashed and returns it.
 *
 * Unlike {@link processFile} this does NOT produce per-chunk merkle proofs. On
 * upload the server ignores the proof and rebuilds the tree from the stored
 * chunks (the chunks ARE the content, so the server's tree always matches),
 * so generating proofs here would be wasted work and would force the whole tree
 * to be built before anything could be sent. The root is still returned for the
 * content id / resolved fileId. Download proofs are unaffected — those are
 * generated server-side from its rebuilt tree.
 *
 * The returned root is byte-identical to {@link processFile}'s for the same
 * chunks (both fold via {@link buildMerkleTree}).
 */
export async function processFileStreaming(
  source: ReadableStream<Uint8Array>,
  fileSize: number,
  encryptChunk: ((chunk: Uint8Array) => Promise<Uint8Array> | Uint8Array) | undefined,
  onPart: (part: StreamedFilePart) => void,
  targetChunkSize?: number,
): Promise<{ totalChunks: number; rootHash: Uint8Array }> {
  const wireChunkSize = targetChunkSize ?? CHUNK_SIZE;
  const chunkSize = encryptChunk ? wireChunkSize - AES_GCM_OVERHEAD : wireChunkSize;
  const encrypted = !!encryptChunk;

  // Read entire stream into a single buffer (same as processFile).
  let buf = new Uint8Array(fileSize > 0 ? fileSize : chunkSize);
  let writePos = 0;
  for await (const incoming of source) {
    if (writePos + incoming.length > buf.length) {
      const newBuf = new Uint8Array(Math.max(buf.length * 2, writePos + incoming.length));
      newBuf.set(buf.subarray(0, writePos), 0);
      buf = newBuf;
    }
    buf.set(incoming, writePos);
    writePos += incoming.length;
  }

  const totalChunks = writePos === 0 ? 1 : Math.ceil(writePos / chunkSize);
  const encoded: Uint8Array[] = Array.from({ length: totalChunks });
  let bytesProcessed = 0;

  // Encrypt every chunk concurrently. Each chunk is emitted for sending the
  // moment its own encryption resolves, so emissions interleave with the
  // encryption of later chunks instead of waiting for the whole batch.
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const idx = i;
    const start = idx * chunkSize;
    const end = Math.min(start + chunkSize, writePos);
    // Zero-copy view when encrypting (encryption produces a fresh buffer);
    // copy when not, so the emitted chunk doesn't alias the read buffer.
    const raw =
      start < writePos
        ? encryptChunk
          ? buf.subarray(start, end)
          : buf.slice(start, end)
        : new Uint8Array(0);
    tasks.push(
      (async () => {
        const enc = encryptChunk ? await encryptChunk(raw) : raw;
        encoded[idx] = enc;
        bytesProcessed += enc.length;
        onPart({ chunkData: enc, chunkIndex: idx, totalChunks, bytesProcessed, encrypted });
      })(),
    );
  }
  await Promise.all(tasks);

  // Fold the merkle root from the already-encrypted chunks. Leaf hashing
  // dominates and is parallelized inside buildMerkleTree; building the node
  // array (vs. computing only the root) is negligible and keeps a single,
  // shared fold so the root can never diverge from processFile's.
  const tree = await buildMerkleTree(encoded);
  return { totalChunks, rootHash: tree.nodes.at(-1)!.hash! };
}
