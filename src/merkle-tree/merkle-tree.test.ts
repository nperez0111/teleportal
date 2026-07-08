import { describe, expect, it } from "bun:test";
import { toBase64 } from "teleportal/utils";
import {
  buildMerkleTree,
  buildMerkleTreeFromLeafHashes,
  computeLeafHash,
  deserializeMerkleTree,
  generateMerkleProof,
  processFile,
  processFileStreaming,
  serializeMerkleTree,
  verifyMerkleProof,
  verifyMerkleProofAsync,
  type StreamedFilePart,
} from "./merkle-tree";
import { generateEncryptionKey, decryptUpdate, encryptUpdate } from "../encryption-key";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as BlobPart]).stream();
}

/**
 * A ReadableStream with async iteration removed, mimicking Safari and older
 * Chrome where `ReadableStream[Symbol.asyncIterator]` is undefined. Code that
 * drains the stream must use the reader API, not `for await ... of`.
 */
function nonAsyncIterableStreamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream();
  (stream as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = undefined;
  return stream;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(b.subarray(off, Math.min(off + 65536, n)));
  }
  return b;
}

describe("Merkle Tree", () => {
  it("builds an identical tree from precomputed leaf hashes", async () => {
    // Odd counts exercise the carried-up trailing node path.
    for (const count of [1, 2, 3, 5]) {
      const chunks = Array.from({ length: count }, (_, i) => randomBytes(64 + i));
      const fromChunks = await buildMerkleTree(chunks);
      const leafHashes = await Promise.all(chunks.map((c) => computeLeafHash(c)));
      const fromHashes = buildMerkleTreeFromLeafHashes(leafHashes);
      expect(fromHashes.leafCount).toBe(fromChunks.leafCount);
      expect(fromHashes.nodes.at(-1)?.hash).toEqual(fromChunks.nodes.at(-1)?.hash!);
      expect(serializeMerkleTree(fromHashes)).toEqual(serializeMerkleTree(fromChunks));
    }
  });

  it("rejects empty leaf hash arrays", () => {
    expect(() => buildMerkleTreeFromLeafHashes([])).toThrow();
  });

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
    const isValid = verifyMerkleProof(chunks[0], proof, root!.hash!, 0, 1);
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

    const isValid = verifyMerkleProof(chunks[0], proof, root!.hash!, 0, chunks.length);
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
    const isValid = verifyMerkleProof(modifiedChunk, proof, root!.hash!, 0, chunks.length);
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
      const isValid = verifyMerkleProof(chunk, proof, root!.hash!, i, chunks.length);
      expect(isValid).toBe(true);
    }
  });

  it("does not collide between [A,B,C] and [A,B,C,C] (duplication attack)", async () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    const c = new Uint8Array([3]);

    const root3 = (await buildMerkleTree([a, b, c])).nodes.at(-1)!.hash!;
    const root4 = (await buildMerkleTree([a, b, c, c])).nodes.at(-1)!.hash!;

    expect(toBase64(root3)).not.toBe(toBase64(root4));
  });

  it("domain-separates leaves from internal nodes", async () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);

    // Leaf hashes for a and b.
    const leafA = (await buildMerkleTree([a])).nodes[0].hash!;
    const leafB = (await buildMerkleTree([b])).nodes[0].hash!;

    // The internal root of [a, b].
    const internalRoot = (await buildMerkleTree([a, b])).nodes.at(-1)!.hash!;

    // A single 64-byte chunk equal to leafA‖leafB. Without domain separation its
    // leaf hash would equal the internal parent of [a, b].
    const forged = new Uint8Array(64);
    forged.set(leafA, 0);
    forged.set(leafB, 32);
    const forgedRoot = (await buildMerkleTree([forged])).nodes.at(-1)!.hash!;

    expect(toBase64(forgedRoot)).not.toBe(toBase64(internalRoot));
  });

  it("verifies proofs across a range of odd and even leaf counts", async () => {
    for (const n of [1, 2, 3, 5, 7, 8, 9, 16, 17]) {
      const chunks = Array.from({ length: n }, (_, i) => new Uint8Array([i, i * 2, i * 3]));
      const tree = await buildMerkleTree(chunks);
      const root = tree.nodes.at(-1)!.hash!;

      for (let i = 0; i < n; i++) {
        const proof = generateMerkleProof(tree, i);
        expect(verifyMerkleProof(chunks[i], proof, root, i, n)).toBe(true);
      }

      // Round-trip through serialization preserves the structure and roots.
      const restored = deserializeMerkleTree(serializeMerkleTree(tree), n);
      expect(toBase64(restored.nodes.at(-1)!.hash!)).toBe(toBase64(root));
      for (let i = 0; i < n; i++) {
        const proof = generateMerkleProof(restored, i);
        expect(verifyMerkleProof(chunks[i], proof, root, i, n)).toBe(true);
      }
    }
  });
});

describe("verifyMerkleProofAsync", () => {
  it("agrees with verifyMerkleProof for every chunk count 1..64", async () => {
    for (let n = 1; n <= 64; n++) {
      const chunks = Array.from({ length: n }, (_, i) => new Uint8Array([i, i * 2, i * 3]));
      const tree = await buildMerkleTree(chunks);
      const root = tree.nodes.at(-1)!.hash!;

      for (let i = 0; i < n; i++) {
        const proof = generateMerkleProof(tree, i);
        expect(await verifyMerkleProofAsync(chunks[i], proof, root, i, n)).toBe(true);
        expect(verifyMerkleProof(chunks[i], proof, root, i, n)).toBe(true);
      }
    }
  });

  it("rejects a tampered chunk", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const tree = await buildMerkleTree(chunks);
    const root = tree.nodes.at(-1)!.hash!;
    const proof = generateMerkleProof(tree, 0);

    expect(await verifyMerkleProofAsync(new Uint8Array([9, 9, 9]), proof, root, 0, 2)).toBe(false);
  });

  it("rejects a proof with leftover elements", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const tree = await buildMerkleTree(chunks);
    const root = tree.nodes.at(-1)!.hash!;
    const proof = [...generateMerkleProof(tree, 0), new Uint8Array(32)];

    expect(await verifyMerkleProofAsync(chunks[0], proof, root, 0, 2)).toBe(false);
  });

  it("rejects an out-of-range or non-integer index", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const tree = await buildMerkleTree(chunks);
    const root = tree.nodes.at(-1)!.hash!;
    const proof = generateMerkleProof(tree, 0);

    expect(await verifyMerkleProofAsync(chunks[0], proof, root, -1, 2)).toBe(false);
    expect(await verifyMerkleProofAsync(chunks[0], proof, root, 2, 2)).toBe(false);
    expect(await verifyMerkleProofAsync(chunks[0], proof, root, 0.5, 2)).toBe(false);
  });
});

describe("processFileStreaming", () => {
  it("drains a non-async-iterable stream (Safari/older Chrome)", async () => {
    const bytes = randomBytes(16 * 3 + 7);
    const target = 16;

    const expected = toBase64(
      (await processFile(streamOf(bytes), bytes.length, undefined, target)).at(-1)!.rootHash,
    );

    // Both entry points must work when for-await-of is unavailable on the stream.
    const emitted: StreamedFilePart[] = [];
    const { rootHash } = await processFileStreaming(
      nonAsyncIterableStreamOf(bytes),
      bytes.length,
      undefined,
      (p) => emitted.push(p),
      target,
    );
    expect(toBase64(rootHash)).toBe(expected);

    const parts = await processFile(
      nonAsyncIterableStreamOf(bytes),
      bytes.length,
      undefined,
      target,
    );
    expect(toBase64(parts.at(-1)!.rootHash)).toBe(expected);
  });

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
    const key = await generateEncryptionKey();
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
