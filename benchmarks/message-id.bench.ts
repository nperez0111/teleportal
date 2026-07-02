import { describe, it } from "bun:test";
import { bench, benchBatch } from "./helpers";

/**
 * Compares message-ID hashing strategies.
 *
 * `CustomMessage.id` hashes the *entire encoded message* (src/lib/protocol/
 * message-types.ts). For file chunks that buffer is ~1MB, so large-buffer
 * throughput dominates uploads; sync/ack messages are tens to hundreds of bytes.
 *
 * Variants:
 *  - old-float    : the previously-shipped inline 2× hash — `(h ^ b) * prime | 0`.
 *                   Two 32-bit lanes → 64-bit id. The float multiply overflows
 *                   2^53 before `| 0`, so it is NOT true FNV-1a (and ~4.7× slower).
 *  - lib0-single  : lib0 hash/fnv1a `digest` — `Math.imul(h ^ b, prime)`.
 *                   One 32-bit lane → 32-bit id (correct FNV-1a).
 *  - lib0-double  : two correct `Math.imul` lanes → 64-bit id. This is what
 *                   `CustomMessage.id` ships today.
 */

const BASIS = 0x811c9dc5;
const PRIME1 = 0x01000193;
const PRIME2 = 0x100001b3;
const BASIS2 = 0x1000193;

// ---- Raw hashes (number output, isolates the algorithm) --------------------

function currentHash(data: Uint8Array): [number, number] {
  let h1 = BASIS;
  let h2 = BASIS2;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    h1 = ((h1 ^ b) * PRIME1) | 0;
    h2 = ((h2 ^ b) * PRIME2) | 0;
  }
  return [h1 >>> 0, h2 >>> 0];
}

function lib0Digest(data: Uint8Array, hash = BASIS): number {
  for (let i = 0; i < data.length; i++) {
    hash = Math.imul(hash ^ data[i], PRIME1);
  }
  return hash >>> 0;
}

function lib0DoubleHash(data: Uint8Array): [number, number] {
  let h1 = BASIS;
  let h2 = BASIS2;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    h1 = Math.imul(h1 ^ b, PRIME1);
    h2 = Math.imul(h2 ^ b, PRIME2);
  }
  return [h1 >>> 0, h2 >>> 0];
}

// ---- Full id strings (what the getter actually returns) --------------------

const hex8 = (n: number) => n.toString(16).padStart(8, "0");

function currentId(data: Uint8Array): string {
  const [a, b] = currentHash(data);
  return hex8(a) + hex8(b);
}

function lib0SingleId(data: Uint8Array): string {
  return hex8(lib0Digest(data));
}

function lib0DoubleId(data: Uint8Array): string {
  const [a, b] = lib0DoubleHash(data);
  return hex8(a) + hex8(b);
}

function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  // crypto.getRandomValues caps at 65536 bytes per call.
  for (let off = 0; off < size; off += 65536) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, size)));
  }
  return buf;
}

const SIZES: { label: string; bytes: number; batch: number }[] = [
  { label: "32 B  (ack)", bytes: 32, batch: 20000 },
  { label: "256 B (sync)", bytes: 256, batch: 8000 },
  { label: "64 KB", bytes: 64 * 1024, batch: 200 },
  { label: "1 MB  (chunk)", bytes: 1024 * 1024, batch: 0 },
];

const mbPerSec = (opsPerSec: number, bytes: number) =>
  `${((opsPerSec * bytes) / 1_048_576).toFixed(0)} MB/s`;

describe("message-id hashing: old-float (|0) vs lib0 (Math.imul)", () => {
  // Keep results live so the JIT can't elide the loops.
  let sink = "";

  it("correctness: old-float lane diverges from correct FNV-1a", () => {
    let oldMatchesImul = true;
    for (let i = 0; i < 2000; i++) {
      const data = randomBytes(1 + (i % 300));
      const old = currentHash(data)[0]; // lane 1 of the old float impl
      const imul = lib0Digest(data); // correct FNV-1a 32-bit
      if (old !== imul) oldMatchesImul = false;
    }
    console.log(
      `\n  old-float lane == correct FNV-1a (Math.imul)? ${oldMatchesImul}` +
        ` — when false, the old hash was deterministic but non-standard FNV.`,
    );

    // Collision sanity over distinct small inputs for each id width.
    const seenSingle = new Set<string>();
    const seenDouble = new Set<string>();
    let colSingle = 0;
    let colDouble = 0;
    const N = 200000;
    for (let i = 0; i < N; i++) {
      const data = new Uint8Array(8);
      new DataView(data.buffer).setFloat64(0, i);
      const s = lib0SingleId(data);
      const d = lib0DoubleId(data);
      if (seenSingle.has(s)) colSingle++;
      else seenSingle.add(s);
      if (seenDouble.has(d)) colDouble++;
      else seenDouble.add(d);
    }
    console.log(
      `  collisions over ${N.toLocaleString()} distinct inputs — ` +
        `32-bit single: ${colSingle}, 64-bit double: ${colDouble}`,
    );
  });

  for (const { label, bytes, batch } of SIZES) {
    it(`${label}`, async () => {
      const data = randomBytes(bytes);
      console.log(`\n  --- ${label} (id string) ---`);

      if (batch > 0) {
        const c = await benchBatch(
          "old-float   ",
          () => {
            for (let i = 0; i < batch; i++) sink = currentId(data);
          },
          { batchSize: batch },
        );
        const s = await benchBatch(
          "lib0-single ",
          () => {
            for (let i = 0; i < batch; i++) sink = lib0SingleId(data);
          },
          { batchSize: batch },
        );
        const d = await benchBatch(
          "lib0-double ",
          () => {
            for (let i = 0; i < batch; i++) sink = lib0DoubleId(data);
          },
          { batchSize: batch },
        );
        console.log(
          `  throughput — old-float: ${mbPerSec(c.opsPerSec, bytes)}, ` +
            `lib0-single: ${mbPerSec(s.opsPerSec, bytes)}, ` +
            `lib0-double: ${mbPerSec(d.opsPerSec, bytes)}`,
        );
      } else {
        const c = await bench("old-float   ", () => {
          sink = currentId(data);
        });
        const s = await bench("lib0-single ", () => {
          sink = lib0SingleId(data);
        });
        const d = await bench("lib0-double ", () => {
          sink = lib0DoubleId(data);
        });
        console.log(
          `  throughput — old-float: ${mbPerSec(c.opsPerSec, bytes)}, ` +
            `lib0-single: ${mbPerSec(s.opsPerSec, bytes)}, ` +
            `lib0-double: ${mbPerSec(d.opsPerSec, bytes)}`,
        );
      }

      if (sink.length === 0) throw new Error("dead code eliminated");
    });
  }
});
