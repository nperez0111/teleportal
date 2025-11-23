import { describe, expect, it } from "bun:test";
import {
  buildMerkleTree,
  deserializeMerkleTree,
  generateMerkleProof,
  serializeMerkleTree,
  verifyMerkleProof,
} from "./merkle-tree";

describe("Merkle Tree", () => {
  it("should build a merkle tree from chunks", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = buildMerkleTree(chunks);

    expect(tree.leafCount).toBe(3);
    expect(tree.nodes.length).toBeGreaterThan(3); // Should have internal nodes
    expect(tree.nodes[tree.nodes.length - 1].hash).toBeDefined(); // Root hash
  });

  it("should build a merkle tree from a single chunk", () => {
    const chunks = [new Uint8Array([1, 2, 3, 4, 5])];

    const tree = buildMerkleTree(chunks);

    expect(tree.leafCount).toBe(1);
    expect(tree.nodes.length).toBe(1); // Single node is both leaf and root
    expect(tree.nodes[0].hash).toBeDefined();
  });

  it("should build a merkle tree from a single empty chunk (0-byte file)", () => {
    const chunks = [new Uint8Array(0)];

    const tree = buildMerkleTree(chunks);

    expect(tree.leafCount).toBe(1);
    expect(tree.nodes.length).toBe(1); // Single node is both leaf and root
    expect(tree.nodes[0].hash).toBeDefined();
    expect(tree.nodes[0].hash!.length).toBe(32); // SHA-256 hash is 32 bytes

    // Verify we can generate and verify a proof for the empty chunk
    const proof = generateMerkleProof(tree, 0);
    expect(proof.length).toBe(0); // Single chunk has no proof path
    const root = tree.nodes[tree.nodes.length - 1].hash!;
    const isValid = verifyMerkleProof(chunks[0], proof, root, 0);
    expect(isValid).toBe(true);
  });

  it("should generate merkle proof for a chunk", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = buildMerkleTree(chunks);
    const proof = generateMerkleProof(tree, 0);

    expect(proof.length).toBeGreaterThan(0);
    expect(proof.every((p) => p.length === 32)).toBe(true); // SHA-256 hashes are 32 bytes
  });

  it("should verify merkle proof correctly", () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = buildMerkleTree(chunks);
    const root = tree.nodes[tree.nodes.length - 1].hash!;
    const proof = generateMerkleProof(tree, 0);

    const isValid = verifyMerkleProof(chunks[0], proof, root, 0);
    expect(isValid).toBe(true);
  });

  it("should reject invalid merkle proof", () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

    const tree = buildMerkleTree(chunks);
    const root = tree.nodes[tree.nodes.length - 1].hash!;
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

    const tree = buildMerkleTree(chunks);
    const serialized = serializeMerkleTree(tree);
    const deserialized = deserializeMerkleTree(serialized, chunks.length);

    expect(deserialized.leafCount).toBe(tree.leafCount);
    expect(deserialized.nodes.length).toBe(tree.nodes.length);

    // Verify root hash matches
    const originalRoot = tree.nodes[tree.nodes.length - 1].hash!;
    const deserializedRoot =
      deserialized.nodes[deserialized.nodes.length - 1].hash!;
    expect(deserializedRoot).toEqual(originalRoot);
  });

  it("should handle large number of chunks", () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      chunks.push(new Uint8Array([i, i + 1, i + 2]));
    }

    const tree = buildMerkleTree(chunks);
    expect(tree.leafCount).toBe(100);

    // Verify all chunks can generate proofs
    for (let i = 0; i < chunks.length; i++) {
      const proof = generateMerkleProof(tree, i);
      const root = tree.nodes[tree.nodes.length - 1].hash!;
      const isValid = verifyMerkleProof(chunks[i], proof, root, i);
      expect(isValid).toBe(true);
    }
  });
});
