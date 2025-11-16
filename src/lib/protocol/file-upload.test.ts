import { describe, expect, it } from "bun:test";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  deserializeMerkleTree,
  generateMerkleProof,
  serializeMerkleTree,
  verifyMerkleProof,
} from "./file-upload";

describe("Merkle Tree", () => {
  it("should build a merkle tree from chunks", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = buildMerkleTree(chunks);

    expect(tree.chunkCount).toBe(3);
    expect(tree.root).toBeDefined();
    expect(tree.root.hash).toBeInstanceOf(Uint8Array);
    expect(tree.root.hash.length).toBe(32); // SHA-256 produces 32-byte hashes
  });

  it("should handle single chunk", () => {
    const chunks = [new Uint8Array([1, 2, 3, 4, 5])];
    const tree = buildMerkleTree(chunks);

    expect(tree.chunkCount).toBe(1);
    expect(tree.root.hash).toBeInstanceOf(Uint8Array);
  });

  it("should generate merkle proof for a chunk", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = buildMerkleTree(chunks);
    const proof = generateMerkleProof(tree, 0);

    expect(proof).toBeInstanceOf(Array);
    expect(proof.length).toBeGreaterThan(0);
    expect(proof.every((p) => p instanceof Uint8Array)).toBe(true);
  });

  it("should verify merkle proof correctly", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = buildMerkleTree(chunks);
    const root = tree.root.hash;

    for (let i = 0; i < chunks.length; i++) {
      const proof = generateMerkleProof(tree, i);
      const isValid = verifyMerkleProof(chunks[i], proof, root, i);
      expect(isValid).toBe(true);
    }
  });

  it("should reject invalid merkle proof", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ];

    const tree = buildMerkleTree(chunks);
    const root = tree.root.hash;
    const proof = generateMerkleProof(tree, 0);

    // Modify the chunk
    const modifiedChunk = new Uint8Array([9, 9, 9]);
    const isValid = verifyMerkleProof(modifiedChunk, proof, root, 0);
    expect(isValid).toBe(false);
  });

  it("should serialize and deserialize merkle tree", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const originalTree = buildMerkleTree(chunks);
    const serialized = serializeMerkleTree(originalTree);
    const deserialized = deserializeMerkleTree(serialized, chunks.length);

    expect(deserialized.chunkCount).toBe(originalTree.chunkCount);
    expect(deserialized.root.hash).toEqual(originalTree.root.hash);
  });

  it("should handle odd number of chunks", () => {
    const chunks = [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
      new Uint8Array([4]),
      new Uint8Array([5]),
    ];

    const tree = buildMerkleTree(chunks);
    expect(tree.chunkCount).toBe(5);

    // Verify all chunks
    const root = tree.root.hash;
    for (let i = 0; i < chunks.length; i++) {
      const proof = generateMerkleProof(tree, i);
      const isValid = verifyMerkleProof(chunks[i], proof, root, i);
      expect(isValid).toBe(true);
    }
  });

  it("should work with 64KB chunks", () => {
    const chunk1 = new Uint8Array(CHUNK_SIZE).fill(1);
    const chunk2 = new Uint8Array(CHUNK_SIZE).fill(2);
    const chunks = [chunk1, chunk2];

    const tree = buildMerkleTree(chunks);
    expect(tree.chunkCount).toBe(2);

    const proof = generateMerkleProof(tree, 0);
    const isValid = verifyMerkleProof(chunk1, proof, tree.root.hash, 0);
    expect(isValid).toBe(true);
  });
});
