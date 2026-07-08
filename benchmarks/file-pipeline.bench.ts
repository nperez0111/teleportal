import { describe, it, expect } from "bun:test";
import { toBase64 } from "lib0/buffer";
import { processFile, processFileStreaming } from "../src/merkle-tree/merkle-tree";
import { createEncryptionKey, encryptUpdate } from "../src/encryption-key";

/**
 * Benchmark: batch `processFile` vs pipelined `processFileStreaming` for uploads.
 *
 * processFile runs strict phases: read-all → Promise.all(encrypt) →
 * buildMerkleTree → generateMerkleProof per chunk → return FilePart[]. The
 * caller only starts SENDING after all of that finishes.
 *
 * processFileStreaming (production) emits each chunk the instant its encryption
 * resolves — overlapping the socket drain with encryption of later chunks — and
 * folds the root concurrently, skipping per-chunk proofs (the server ignores
 * them on upload and rebuilds the tree from the stored chunks).
 */

// ---- A serialized "wire": a socket draining at a fixed bandwidth ------------

class Wire {
  #bytesPerMs: number;
  #queue: number[] = [];
  #draining = false;
  #idleResolvers: (() => void)[] = [];
  firstSentAt = -1;

  constructor(mbPerSec: number) {
    this.#bytesPerMs = (mbPerSec * 1_048_576) / 1000;
  }
  enqueue(bytes: number) {
    this.#queue.push(bytes);
    void this.#drain();
  }
  async #drain() {
    if (this.#draining) return;
    this.#draining = true;
    while (this.#queue.length) {
      if (this.firstSentAt < 0) this.firstSentAt = performance.now();
      const bytes = this.#queue.shift()!;
      await new Promise((r) => setTimeout(r, bytes / this.#bytesPerMs));
    }
    this.#draining = false;
    this.#idleResolvers.splice(0).forEach((r) => r());
  }
  idle(): Promise<void> {
    if (!this.#draining && this.#queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.#idleResolvers.push(r));
  }
}

describe("file upload: batch processFile vs pipelined processFileStreaming", () => {
  it("processFileStreaming root matches processFile root (equivalence)", async () => {
    // Unencrypted (deterministic) data: encryptUpdate uses a random IV per
    // chunk, so two encryptions of the same bytes give different ciphertext.
    const bytes = new Uint8Array(5 * 1024 * 1024 + 12345);
    for (let off = 0; off < bytes.length; off += 65536) {
      crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, bytes.length)));
    }

    const batch = await processFile(new Blob([bytes as BlobPart]).stream(), bytes.length);
    const { rootHash } = await processFileStreaming(
      new Blob([bytes as BlobPart]).stream(),
      bytes.length,
      undefined,
      () => {},
    );
    expect(toBase64(rootHash)).toBe(toBase64(batch.at(-1)!.rootHash));
    expect(batch.length).toBeGreaterThan(1);
  });

  it("measures time-to-first-chunk and total under a bandwidth-limited wire", async () => {
    const keyResolver = createEncryptionKey();
    const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
    const FILE_BYTES = 50 * 1024 * 1024;
    const bytes = new Uint8Array(FILE_BYTES);
    for (let off = 0; off < FILE_BYTES; off += 65536) {
      crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, FILE_BYTES)));
    }
    const enc = (c: Uint8Array) => encryptUpdate(key, c);

    // CPU-only cost of each producer (no wire). Pipelined skips proof
    // generation; take the min of a few runs to cut event-loop noise.
    let batchCpu = Infinity;
    let pipeCpu = Infinity;
    for (let r = 0; r < 4; r++) {
      let t = performance.now();
      await processFile(new Blob([bytes as BlobPart]).stream(), FILE_BYTES, enc);
      batchCpu = Math.min(batchCpu, performance.now() - t);
      t = performance.now();
      await processFileStreaming(new Blob([bytes as BlobPart]).stream(), FILE_BYTES, enc, () => {});
      pipeCpu = Math.min(pipeCpu, performance.now() - t);
    }
    console.log(
      `\n  CPU-only (no wire): batch processFile=${batchCpu.toFixed(0)}ms  pipelined=${pipeCpu.toFixed(0)}ms  (50 MB encrypted)`,
    );

    for (const mbPerSec of [50, 200, 1000]) {
      console.log(`\n  --- 50 MB encrypted upload over a ${mbPerSec} MB/s wire ---`);

      // BATCH: full processFile (read+encrypt+tree+proofs), THEN send.
      {
        const wire = new Wire(mbPerSec);
        const t0 = performance.now();
        const parts = await processFile(new Blob([bytes as BlobPart]).stream(), FILE_BYTES, enc);
        const procDone = performance.now() - t0;
        for (const p of parts) wire.enqueue(p.chunkData.length);
        await wire.idle();
        const total = performance.now() - t0;
        console.log(
          `  batch      proc=${procDone.toFixed(0)}ms  first-chunk-on-wire=${(wire.firstSentAt - t0).toFixed(0)}ms  total=${total.toFixed(0)}ms`,
        );
      }

      // PIPELINED: emit each chunk as it encrypts; root folded concurrently.
      {
        const wire = new Wire(mbPerSec);
        const t0 = performance.now();
        await processFileStreaming(new Blob([bytes as BlobPart]).stream(), FILE_BYTES, enc, (c) =>
          wire.enqueue(c.chunkData.length),
        );
        const procDone = performance.now() - t0;
        await wire.idle();
        const total = performance.now() - t0;
        console.log(
          `  pipelined  proc=${procDone.toFixed(0)}ms  first-chunk-on-wire=${(wire.firstSentAt - t0).toFixed(0)}ms  total=${total.toFixed(0)}ms`,
        );
      }
    }
  }, 60000);
});
