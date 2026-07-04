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
 * Domain-separation prefixes (RFC 6962 style). A leaf hashes `0x00 ‖ chunk`
 * and an internal node hashes `0x01 ‖ left ‖ right`, so a chunk can never hash
 * to the same value as an internal node (a 64-byte chunk equal to two
 * concatenated child hashes would otherwise collide with their parent).
 */
const LEAF_PREFIX = 0x00;
const INTERNAL_PREFIX = 0x01;

/**
 * Hash two child hashes together to create a parent hash (sync, using lib0
 * digest). Prefixed with {@link INTERNAL_PREFIX} for domain separation.
 * Used in verifyMerkleProof and buildMerkleTree's internal levels where async
 * overhead would outweigh the crypto speedup.
 */
function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(1 + 32 + 32);
  combined[0] = INTERNAL_PREFIX;
  combined.set(left, 1);
  combined.set(right, 33);
  return digest(combined);
}

/**
 * Hash a chunk into a leaf hash (sync), prefixed with {@link LEAF_PREFIX}.
 */
function leafHash(chunk: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(chunk.length + 1);
  prefixed[0] = LEAF_PREFIX;
  prefixed.set(chunk, 1);
  return digest(prefixed);
}

/**
 * Hardware-accelerated SHA-256 leaf digest via Web Crypto API, prefixed with
 * {@link LEAF_PREFIX} for domain separation. Exported so storage adapters can
 * precompute leaf hashes at chunk-write time (e.g. stored as object metadata)
 * and later build the tree via {@link buildMerkleTreeFromLeafHashes} without
 * re-reading chunk bytes. A plain unprefixed SHA-256 will NOT match.
 */
export async function computeLeafHash(chunk: Uint8Array): Promise<Uint8Array> {
  const prefixed = new Uint8Array(chunk.length + 1);
  prefixed[0] = LEAF_PREFIX;
  prefixed.set(chunk, 1);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", prefixed as BufferSource));
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

  // Hash all leaves in parallel using hardware-accelerated SHA-256
  const leafHashes = await Promise.all(chunks.map((chunk) => computeLeafHash(chunk)));
  return buildMerkleTreeFromLeafHashes(leafHashes);
}

/**
 * Build a merkle tree from precomputed leaf hashes (see
 * {@link computeLeafHash} — hashes must be domain-separated leaf digests).
 * Identical tree shape and root as {@link buildMerkleTree} over the raw
 * chunks.
 */
export function buildMerkleTreeFromLeafHashes(leafHashes: Uint8Array[]): MerkleTree {
  if (leafHashes.length === 0) {
    throw new Error("Cannot build merkle tree from empty leaf hash array");
  }

  const nodes: MerkleNode[] = [];
  const leafCount = leafHashes.length;

  // Create leaf nodes
  for (const hash of leafHashes) {
    nodes.push({ hash });
  }

  // Build internal nodes bottom-up using sync hashing (each internal node hashes
  // only 65 bytes, where async crypto.subtle overhead would dwarf the work).
  //
  // Pairs are hashed left-to-right; an odd trailing node is carried up to the
  // next level UNCHANGED rather than self-paired. Self-pairing would make
  // `[A, B, C]` and `[A, B, C, C]` share a root (a duplication attack), which is
  // unacceptable now that the root is a content-addressed identity.
  let level: number[] = nodes.map((_, i) => i);
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const leftIdx = level[i];
        const rightIdx = level[i + 1];
        const parentIndex = nodes.length;
        nodes.push({
          hash: hashPair(nodes[leftIdx].hash!, nodes[rightIdx].hash!),
          left: leftIdx,
          right: rightIdx,
        });
        nodes[leftIdx].parent = parentIndex;
        nodes[rightIdx].parent = parentIndex;
        next.push(parentIndex);
      } else {
        // Odd trailing node — carry it up unchanged (no self-pair).
        next.push(level[i]);
      }
    }
    level = next;
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
 * `leafCount` (the total number of chunks in the file) is required because the
 * tree carries odd trailing nodes up unpaired: without it the verifier cannot
 * tell which levels contribute a sibling and would desync from the proof.
 *
 * @param chunk - The chunk data to verify
 * @param proof - Array of sibling hashes from the proof path (bottom-up)
 * @param root - The expected merkle root hash
 * @param index - Zero-based index of the chunk
 * @param leafCount - Total number of leaves (chunks) in the tree
 * @returns True if the chunk is valid, false otherwise
 */
export function verifyMerkleProof(
  chunk: Uint8Array,
  proof: Uint8Array[],
  root: Uint8Array,
  index: number,
  leafCount: number,
): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= leafCount) {
    return false;
  }
  return verifyProofFromLeafHash(leafHash(chunk), proof, root, index, leafCount);
}

/**
 * Like {@link verifyMerkleProof} but hashes the leaf with hardware-accelerated
 * `crypto.subtle` instead of the synchronous pure-JS digest. In browsers the
 * sync digest runs at ~20MB/s on the main thread (~50ms per 1MB chunk), so the
 * download path uses this variant to keep per-chunk verification off the main
 * thread; the proof walk itself only hashes 65-byte pairs and stays sync.
 */
export async function verifyMerkleProofAsync(
  chunk: Uint8Array,
  proof: Uint8Array[],
  root: Uint8Array,
  index: number,
  leafCount: number,
): Promise<boolean> {
  if (!Number.isInteger(index) || index < 0 || index >= leafCount) {
    return false;
  }
  return verifyProofFromLeafHash(await computeLeafHash(chunk), proof, root, index, leafCount);
}

/**
 * Walk a proof up from a (domain-separated) leaf hash and compare against the
 * root. Shared by {@link verifyMerkleProof} and {@link verifyMerkleProofAsync}
 * so both verify identically.
 */
function verifyProofFromLeafHash(
  leaf: Uint8Array,
  proof: Uint8Array[],
  root: Uint8Array,
  index: number,
  leafCount: number,
): boolean {
  let currentHash = leaf;

  // Walk up, mirroring buildMerkleTree's carry-up: a node that is the last of an
  // odd-sized level has no sibling — it is carried up, consuming no proof
  // element — so only paired levels pull a sibling from the proof.
  let pos = index;
  let levelSize = leafCount;
  let proofIndex = 0;
  while (levelSize > 1) {
    const isCarried = pos === levelSize - 1 && levelSize % 2 === 1;
    if (!isCarried) {
      const sibling = proof[proofIndex++];
      if (sibling === undefined) {
        return false;
      }
      currentHash = pos % 2 === 0 ? hashPair(currentHash, sibling) : hashPair(sibling, currentHash);
    }
    pos = Math.floor(pos / 2);
    levelSize = Math.ceil(levelSize / 2);
  }

  // A well-formed proof is consumed exactly; leftover elements mean it is malformed.
  if (proofIndex !== proof.length) {
    return false;
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
  // Each node: 32 bytes (SHA-256 hash) + 4 bytes (left child) + 4 bytes (right
  // child), each child index 0xFFFFFFFF if absent. Left/right are stored
  // explicitly (rather than reconstructed from parent pointers by node index)
  // because carry-up can pair a node with a LOWER-indexed sibling, so index
  // order does not determine child side. Parent pointers are rebuilt on load.
  // Format: [leafCount (4 bytes)] [node_hash (32)] [node_left (4)] [node_right (4)] ...
  const nodeSize = 32 + 4 + 4;
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

    view.setUint32(offset, node.left === undefined ? 0xff_ff_ff_ff : node.left, true);
    offset += 4;
    view.setUint32(offset, node.right === undefined ? 0xff_ff_ff_ff : node.right, true);
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
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Read leaf count (should match chunkCount)
  const storedLeafCount = view.getUint32(0, true);
  if (storedLeafCount !== chunkCount) {
    throw new Error(
      `Stored leaf count ${storedLeafCount} does not match chunk count ${chunkCount}`,
    );
  }

  const nodes: MerkleNode[] = [];
  let offset = 4;

  // Read all nodes (hash + left child + right child)
  while (offset < data.length) {
    const hash = data.slice(offset, offset + 32);
    offset += 32;
    const left = view.getUint32(offset, true);
    offset += 4;
    const right = view.getUint32(offset, true);
    offset += 4;

    const node: MerkleNode = { hash };
    if (left !== 0xff_ff_ff_ff) {
      node.left = left;
    }
    if (right !== 0xff_ff_ff_ff) {
      node.right = right;
    }

    nodes.push(node);
  }

  // Rebuild parent pointers from the explicit left/right children.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.left !== undefined) {
      nodes[node.left].parent = i;
    }
    if (node.right !== undefined) {
      nodes[node.right].parent = i;
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
 * Read a whole {@link ReadableStream} into a single contiguous buffer.
 *
 * Uses the reader API (`getReader().read()`) rather than `for await ... of`
 * because async iteration of a `ReadableStream` is not supported in Safari (and
 * older Chrome) — only Firefox, Node, and Bun implement it. The reader API works
 * everywhere.
 *
 * @param source - The byte stream to drain
 * @param fileSize - Expected size (used to pre-size the buffer); may be 0/unknown
 * @param fallbackSize - Initial buffer size when `fileSize` is not positive
 */
async function readStreamFully(
  source: ReadableStream<Uint8Array>,
  fileSize: number,
  fallbackSize: number,
): Promise<{ buf: Uint8Array; writePos: number }> {
  let buf = new Uint8Array(fileSize > 0 ? fileSize : fallbackSize);
  let writePos = 0;
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (writePos + value.length > buf.length) {
        const newBuf = new Uint8Array(Math.max(buf.length * 2, writePos + value.length));
        newBuf.set(buf.subarray(0, writePos), 0);
        buf = newBuf;
      }
      buf.set(value, writePos);
      writePos += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return { buf, writePos };
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
  if (!Number.isFinite(wireChunkSize) || wireChunkSize <= 0) {
    throw new Error(`targetChunkSize must be a positive finite number, got ${wireChunkSize}`);
  }
  if (encryptChunk && wireChunkSize <= AES_GCM_OVERHEAD) {
    throw new Error(
      `targetChunkSize (${wireChunkSize}) must be greater than AES_GCM_OVERHEAD (${AES_GCM_OVERHEAD})`,
    );
  }
  const chunkSize = encryptChunk ? wireChunkSize - AES_GCM_OVERHEAD : wireChunkSize;
  const encrypted = !!encryptChunk;

  // Read entire stream into a single buffer
  const { buf, writePos } = await readStreamFully(source, fileSize, chunkSize);

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
  if (!Number.isFinite(wireChunkSize) || wireChunkSize <= 0) {
    throw new Error(`targetChunkSize must be a positive finite number, got ${wireChunkSize}`);
  }
  if (encryptChunk && wireChunkSize <= AES_GCM_OVERHEAD) {
    throw new Error(
      `targetChunkSize (${wireChunkSize}) must be greater than AES_GCM_OVERHEAD (${AES_GCM_OVERHEAD})`,
    );
  }
  const chunkSize = encryptChunk ? wireChunkSize - AES_GCM_OVERHEAD : wireChunkSize;
  const encrypted = !!encryptChunk;

  // Read entire stream into a single buffer (same as processFile).
  const { buf, writePos } = await readStreamFully(source, fileSize, chunkSize);

  const totalChunks = writePos === 0 ? 1 : Math.ceil(writePos / chunkSize);
  const encoded: Uint8Array[] = Array.from({ length: totalChunks });

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
        const bytesProcessed = end;
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
