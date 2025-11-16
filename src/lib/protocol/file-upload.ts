import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { digest } from "lib0/hash/sha256";

export const FILE_CHUNK_SIZE = 64 * 1024;

export type MerkleNode = {
  index: number;
  hash: Uint8Array;
  parent?: number;
  left?: number;
  right?: number;
};

export type MerkleTree = {
  nodes: MerkleNode[];
  leafOffset: number;
  chunkCount: number;
  paddedLeafCount: number;
};

const EMPTY_CHUNK = new Uint8Array(0);

export function buildMerkleTree(chunks: Uint8Array[]): MerkleTree {
  const chunkCount = chunks.length;
  const chunkHashes =
    chunkCount === 0
      ? [hashChunk(EMPTY_CHUNK)]
      : chunks.map((chunk) => hashChunk(chunk));

  const paddedLeafCount = nextPowerOfTwo(chunkHashes.length);
  const leafOffset = paddedLeafCount - 1;
  const nodeCount = paddedLeafCount * 2 - 1;

  const nodes: MerkleNode[] = new Array(nodeCount);

  for (let i = 0; i < paddedLeafCount; i++) {
    const sourceHash =
      i < chunkHashes.length
        ? chunkHashes[i]
        : chunkHashes[chunkHashes.length - 1];
    const index = leafOffset + i;
    nodes[index] = {
      index,
      hash: sourceHash,
    };
  }

  for (let index = leafOffset - 1; index >= 0; index--) {
    const left = 2 * index + 1;
    const right = left + 1;
    const leftNode = nodes[left];
    const rightNode = nodes[right];
    if (!leftNode || !rightNode) {
      throw new Error("Invalid merkle tree structure");
    }
    const hash = hashPair(leftNode.hash, rightNode.hash);
    const node: MerkleNode = {
      index,
      hash,
      left,
      right,
    };
    nodes[index] = node;
    leftNode.parent = index;
    rightNode.parent = index;
  }

  return {
    nodes,
    leafOffset,
    chunkCount,
    paddedLeafCount,
  };
}

export function generateMerkleProof(
  tree: MerkleTree,
  chunkIndex: number,
): Uint8Array[] {
  if (chunkIndex < 0 || chunkIndex >= tree.chunkCount) {
    throw new RangeError("Chunk index is out of bounds");
  }

  const proof: Uint8Array[] = [];
  let nodeIndex = tree.leafOffset + chunkIndex;

  while (nodeIndex > 0) {
    const isRightChild = nodeIndex % 2 === 0;
    const siblingIndex = isRightChild ? nodeIndex - 1 : nodeIndex + 1;
    const sibling = tree.nodes[siblingIndex];
    if (!sibling) {
      throw new Error("Merkle tree sibling missing during proof generation");
    }
    proof.push(sibling.hash);
    nodeIndex = Math.floor((nodeIndex - 1) / 2);
  }

  return proof;
}

export function verifyMerkleProof(
  chunk: Uint8Array,
  proof: Uint8Array[],
  root: Uint8Array,
  index: number,
): boolean {
  let computedHash = hashChunk(chunk);
  if (index < 0) {
    return false;
  }

  const depth = proof.length;
  const paddedLeafCount = depth === 0 ? 1 : 1 << depth;
  if (index >= paddedLeafCount) {
    return false;
  }

  let nodeIndex = paddedLeafCount - 1 + index;

  for (const siblingHash of proof) {
    const isRightChild = nodeIndex % 2 === 0;
    computedHash = isRightChild
      ? hashPair(siblingHash, computedHash)
      : hashPair(computedHash, siblingHash);
    nodeIndex = Math.floor((nodeIndex - 1) / 2);
  }

  return compareHashes(computedHash, root);
}

export function serializeMerkleTree(tree: MerkleTree): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, tree.nodes.length);
  for (const node of tree.nodes) {
    encoding.writeVarUint8Array(encoder, node.hash);
  }
  return encoding.toUint8Array(encoder);
}

export function deserializeMerkleTree(
  buffer: Uint8Array,
  chunkCount: number,
): MerkleTree {
  const decoder = decoding.createDecoder(buffer);
  const nodeCount = decoding.readVarUint(decoder);
  const nodes: MerkleNode[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodes[i] = {
      index: i,
      hash: decoding.readVarUint8Array(decoder),
    };
  }

  const paddedLeafCount = (nodeCount + 1) / 2;
  const leafOffset = paddedLeafCount - 1;

  for (let index = 0; index < leafOffset; index++) {
    const left = 2 * index + 1;
    const right = left + 1;
    if (left < nodeCount) {
      nodes[index].left = left;
      nodes[left].parent = index;
    }
    if (right < nodeCount) {
      nodes[index].right = right;
      nodes[right].parent = index;
    }
  }

  if (chunkCount > paddedLeafCount) {
    throw new Error("Chunk count exceeds reconstructed tree capacity");
  }

  return {
    nodes,
    leafOffset,
    chunkCount,
    paddedLeafCount,
  };
}

export function getMerkleRoot(tree: MerkleTree): Uint8Array {
  return tree.nodes[0]?.hash ?? hashChunk(EMPTY_CHUNK);
}

function hashChunk(chunk: Uint8Array): Uint8Array {
  return digest(chunk);
}

function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return digest(combined);
}

function compareHashes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function nextPowerOfTwo(value: number): number {
  if (value <= 1) {
    return 1;
  }
  return 1 << (32 - Math.clz32(value - 1));
}
