import { describe, expect, it } from "bun:test";
import { toBase64 } from "teleportal/utils";
import {
  buildMerkleTree,
  deserializeMerkleTree,
  generateMerkleProof,
  processFile,
  processFileStreaming,
  serializeMerkleTree,
  verifyMerkleProof,
  type StreamedFilePart,
} from "./merkle-tree";
import { createEncryptionKey, decryptUpdate, encryptUpdate } from "../encryption-key";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as BlobPart]).stream();
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(b.subarray(off, Math.min(off + 65536, n)));
  }
  return b;
}

describe("Merkle Tree", () => {
  it("should build a merkle tree from chunks", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = await buildMerkleTree(chunks);

    expect(tree.leafCount).toBe(3);
    expect(tree.nodes.length).toBeGreaterThan(3); // Should have internal nodes
    const root = tree.nodes.at(-1);
    expect(root).toBeDefined();
    expect(root?.hash).toBeDefined(); // Root hash
  });

  it("should build a merkle tree from a single chunk", async () => {
    const chunks = [new Uint8Array([1, 2, 3, 4, 5])];

    const tree = await buildMerkleTree(chunks);

    expect(tree.leafCount).toBe(1);
    expect(tree.nodes.length).toBe(1); // Single node is both leaf and root
    expect(tree.nodes[0].hash).toBeDefined();
  });

  it("should build a merkle tree from a single empty chunk (0-byte file)", async () => {
    const chunks = [new Uint8Array(0)];

    const tree = await buildMerkleTree(chunks);

    expect(tree.leafCount).toBe(1);
    expect(tree.nodes.length).toBe(1); // Single node is both leaf and root
    expect(tree.nodes[0].hash).toBeDefined();
    expect(tree.nodes[0].hash!.length).toBe(32); // SHA-256 hash is 32 bytes

    // Verify we can generate and verify a proof for the empty chunk
    const proof = generateMerkleProof(tree, 0);
    expect(proof.length).toBe(0); // Single chunk has no proof path
    const root = tree.nodes.at(-1);
    expect(root).toBeDefined();
    expect(root?.hash).toBeDefined();
    const isValid = verifyMerkleProof(chunks[0], proof, root!.hash!, 0);
    expect(isValid).toBe(true);
  });

  it("should generate merkle proof for a chunk", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = await buildMerkleTree(chunks);
    const proof = generateMerkleProof(tree, 0);

    expect(proof.length).toBeGreaterThan(0);
    expect(proof.every((p) => p.length === 32)).toBe(true); // SHA-256 hashes are 32 bytes
  });

  it("should verify merkle proof correctly", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = await buildMerkleTree(chunks);
    const root = tree.nodes.at(-1);
    expect(root).toBeDefined();
    expect(root?.hash).toBeDefined();
    const proof = generateMerkleProof(tree, 0);

    const isValid = verifyMerkleProof(chunks[0], proof, root!.hash!, 0);
    expect(isValid).toBe(true);
  });

  it("should reject invalid merkle proof", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

    const tree = await buildMerkleTree(chunks);
    const root = tree.nodes.at(-1);
    expect(root).toBeDefined();
    expect(root?.hash).toBeDefined();
    const proof = generateMerkleProof(tree, 0);

    // Modify the chunk
    const modifiedChunk = new Uint8Array([9, 9, 9]);
    const isValid = verifyMerkleProof(modifiedChunk, proof, root!.hash!, 0);
    expect(isValid).toBe(false);
  });

  it("should serialize and deserialize merkle tree", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];

    const tree = await buildMerkleTree(chunks);
    const serialized = serializeMerkleTree(tree);
    const deserialized = deserializeMerkleTree(serialized, chunks.length);

    expect(deserialized.leafCount).toBe(tree.leafCount);
    expect(deserialized.nodes.length).toBe(tree.nodes.length);

    // Verify root hash matches
    const originalRoot = tree.nodes.at(-1);
    expect(originalRoot).toBeDefined();
    expect(originalRoot?.hash).toBeDefined();
    const deserializedRoot = deserialized.nodes.at(-1);
    expect(deserializedRoot).toBeDefined();
    expect(deserializedRoot?.hash).toBeDefined();
    expect(deserializedRoot!.hash!).toEqual(originalRoot!.hash!);
  });

  it("should handle large number of chunks", async () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      chunks.push(new Uint8Array([i, i + 1, i + 2]));
    }

    const tree = await buildMerkleTree(chunks);
    expect(tree.leafCount).toBe(100);

    // Verify all chunks can generate proofs
    const root = tree.nodes.at(-1);
    expect(root).toBeDefined();
    expect(root?.hash).toBeDefined();
    for (const [i, chunk] of chunks.entries()) {
      const proof = generateMerkleProof(tree, i);
      const isValid = verifyMerkleProof(chunk, proof, root!.hash!, i);
      expect(isValid).toBe(true);
    }
  });
});

describe("processFileStreaming", () => {
  it("returns the same root as processFile (unencrypted)", async () => {
    const bytes = randomBytes(16 * 3 + 7); // 4 chunks at targetChunkSize 16
    const target = 16;

    const parts = await processFile(streamOf(bytes), bytes.length, undefined, target);
    const expectedRoot = toBase64(parts.at(-1)!.rootHash);

    const emitted: StreamedFilePart[] = [];
    const { totalChunks, rootHash } = await processFileStreaming(
      streamOf(bytes),
      bytes.length,
      undefined,
      (p) => emitted.push(p),
      target,
    );

    expect(toBase64(rootHash)).toBe(expectedRoot);
    expect(totalChunks).toBe(parts.length);
    expect(emitted.length).toBe(totalChunks);
  });

  it("emits every chunk exactly once with contiguous indices and original bytes", async () => {
    const bytes = randomBytes(16 * 5 + 3);
    const target = 16;

    const emitted: StreamedFilePart[] = [];
    const { totalChunks } = await processFileStreaming(
      streamOf(bytes),
      bytes.length,
      undefined,
      (p) => emitted.push(p),
      target,
    );

    expect(emitted.length).toBe(totalChunks);
    // Reassemble in chunkIndex order and compare to the source.
    emitted.sort((a, b) => a.chunkIndex - b.chunkIndex);
    expect(emitted.map((p) => p.chunkIndex)).toEqual(
      Array.from({ length: totalChunks }, (_, i) => i),
    );
    const reassembled = new Uint8Array(bytes.length);
    let off = 0;
    for (const p of emitted) {
      reassembled.set(p.chunkData, off);
      off += p.chunkData.length;
    }
    expect(toBase64(reassembled)).toBe(toBase64(bytes));
  });

  it("handles an empty file (one empty chunk, defined root)", async () => {
    const emitted: StreamedFilePart[] = [];
    const { totalChunks, rootHash } = await processFileStreaming(
      streamOf(new Uint8Array(0)),
      0,
      undefined,
      (p) => emitted.push(p),
    );
    expect(totalChunks).toBe(1);
    expect(emitted.length).toBe(1);
    expect(emitted[0].chunkData.length).toBe(0);
    expect(rootHash.length).toBe(32);
  });

  it("encrypted: root matches a tree over the emitted ciphertext and round-trips", async () => {
    const key = await createEncryptionKey();
    const bytes = randomBytes(40 * 3 + 11); // multiple encrypted chunks
    const target = 64; // plaintext chunk = 64 - 28 = 36 bytes

    const emitted: StreamedFilePart[] = [];
    const { rootHash } = await processFileStreaming(
      streamOf(bytes),
      bytes.length,
      (c) => encryptUpdate(key, c),
      (p) => emitted.push(p),
      target,
    );

    expect(emitted.length).toBeGreaterThan(1);
    emitted.sort((a, b) => a.chunkIndex - b.chunkIndex);
    for (const p of emitted) expect(p.encrypted).toBe(true);

    // The returned root must equal a tree built over the emitted ciphertext.
    const tree = await buildMerkleTree(emitted.map((p) => p.chunkData));
    expect(toBase64(rootHash)).toBe(toBase64(tree.nodes.at(-1)!.hash!));

    // Decrypting the emitted chunks in order reproduces the original file.
    const decrypted: Uint8Array[] = [];
    for (const p of emitted) decrypted.push(await decryptUpdate(key, p.chunkData));
    const reassembled = new Uint8Array(bytes.length);
    let off = 0;
    for (const d of decrypted) {
      reassembled.set(d, off);
      off += d.length;
    }
    expect(toBase64(reassembled)).toBe(toBase64(bytes));
  });
});
