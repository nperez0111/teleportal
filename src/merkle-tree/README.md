# `teleportal/merkle-tree`

A minimal, dependency-light Merkle tree over SHA-256, used to verify individual
file-transfer chunks and to derive a content-addressed file id (the root hash).

## Why it exists

Teleportal transfers files as a stream of fixed-size chunks. A receiver must be
able to verify **each chunk independently**, as it arrives, without having the
whole file — otherwise a single corrupted or malicious chunk could only be
detected after a full download. A Merkle tree provides exactly that: given the
trusted root hash and a small per-chunk proof (`O(log n)` sibling hashes), any
chunk can be authenticated in isolation.

The root hash also doubles as the file's **content id** (`fileId`): identical
bytes always produce the same root, so the root uniquely identifies the content.

## What it verifies (and a critical gotcha)

The tree is built over the bytes that go **on the wire**. For encrypted
transfers that means the tree hashes the **ciphertext**, not the plaintext. As a
result:

- Chunk verification is **decryption-independent** — `verifyMerkleProof` can (and
  must) run **before** decryption. The download path in
  `src/lib/protocol/file-transfer.ts` gates decryption on `verifyChunk`; a chunk
  that fails its proof is rejected and never decrypted.
- On upload the client encrypts each chunk and then hashes the ciphertext; the
  server rebuilds the tree from the stored ciphertext chunks, so the two roots
  always agree.

## How it works

### Hashing and domain separation (RFC 6962 style)

Leaves and internal nodes are hashed with distinct one-byte prefixes:

- **Leaf:** `SHA-256(0x00 ‖ chunk)`
- **Internal:** `SHA-256(0x01 ‖ leftHash ‖ rightHash)` (always 65 bytes in)

Domain separation prevents a **second-preimage attack**: without it, a single
64-byte chunk equal to `leftHash ‖ rightHash` would hash to the same value as
the internal parent of those two children, letting an attacker pass off an
internal node as a leaf. The prefixes make the two hash inputs disjoint.

### Odd nodes are carried, not duplicated

When a level has an odd number of nodes, the trailing node is **carried up
unchanged** to the next level (it is not paired with itself). Self-pairing would
make `[A, B, C]` and `[A, B, C, C]` share a root (a duplication attack), which is
unacceptable when the root is a content identity. Because of the carry, the
verifier needs `leafCount` to know which levels contribute a sibling.

### Two hashing backends

- **Sync (`lib0/hash/sha256`)** — used for internal-node hashing (only 65 bytes
  per call, where the `crypto.subtle` async overhead would dominate) and for the
  main-thread-cheap `verifyMerkleProof`.
- **Async (`crypto.subtle`, hardware-accelerated)** — used for leaf hashing in
  `buildMerkleTree`/`computeLeafHash` and for `verifyMerkleProofAsync`. In
  browsers the pure-JS digest runs at ~20MB/s (~50ms per 1MB chunk), so the
  download path uses the async variant to keep per-chunk hashing off the main
  thread. Both backends use identical prefixes, so their outputs match exactly.

### Node layout

`MerkleTree.nodes` is a flat array: leaves first (in chunk order), then internal
nodes appended bottom-up, so the **root is always the last node**
(`tree.nodes.at(-1)`). Internal nodes store explicit `left`/`right` child
indices (not reconstructable from position, since a carry can pair a node with a
lower-indexed sibling); `parent` pointers are derived.

## Public API

Constants:

- `CHUNK_SIZE` — 1 MiB plaintext chunk size.
- `AES_GCM_OVERHEAD` — 28 bytes (12-byte nonce + 16-byte tag) added per
  encrypted chunk.
- `ENCRYPTED_CHUNK_SIZE` — `CHUNK_SIZE - AES_GCM_OVERHEAD`.

Building:

- `buildMerkleTree(chunks): Promise<MerkleTree>` — hash leaves (async, parallel)
  and fold the tree. Throws on an empty array.
- `computeLeafHash(chunk): Promise<Uint8Array>` — hardware-accelerated,
  domain-separated leaf digest. A plain SHA-256 will **not** match.
- `buildMerkleTreeFromLeafHashes(leafHashes): MerkleTree` — fold a tree from
  precomputed leaf hashes (e.g. leaf hashes stored as chunk metadata), avoiding
  a re-read of chunk bytes. Same shape/root as `buildMerkleTree`. Throws on an
  empty array.

Proofs:

- `generateMerkleProof(tree, chunkIndex): Uint8Array[]` — bottom-up sibling
  hashes for a chunk. Throws if `chunkIndex` is out of range.
- `verifyMerkleProof(chunk, proof, root, index, leafCount): boolean` — sync
  verification. Returns `false` (never throws) for a bad index, a wrong chunk, a
  tampered/short/over-long proof, or a root mismatch.
- `verifyMerkleProofAsync(...)` — same contract, async leaf hashing.

Serialization:

- `serializeMerkleTree(tree): Uint8Array` — `[leafCount u32][hash 32 | left u32 |
right u32]...`, little-endian, `0xFFFFFFFF` for an absent child.
- `deserializeMerkleTree(data, chunkCount): MerkleTree` — rebuilds parent
  pointers; throws if the stored leaf count disagrees with `chunkCount`.

File processing:

- `processFile(source, fileSize, encryptChunk?, targetChunkSize?): Promise<FilePart[]>`
  — drain a stream, (optionally) encrypt every chunk, build the tree, and return
  every chunk with its proof, index, `totalChunks`, and the root (on the last
  part). Used where all parts are needed up front.
- `processFileStreaming(source, fileSize, encryptChunk, onPart, targetChunkSize?)`
  — pipelined upload: encrypts chunks concurrently and invokes `onPart` as each
  ciphertext is ready (so sending overlaps encryption), then returns the root.
  It does **not** produce per-chunk proofs — the server rebuilds the tree from
  the stored chunks — but its root is byte-identical to `processFile`'s.

Types: `MerkleTree`, `MerkleNode`, `FilePart`, `StreamedFilePart`.

## Gotchas

- `verifyMerkleProof` is anchored on the **trusted root**. A proof only verifies
  if it folds to that exact root, so callers must obtain the root from a trusted
  source (the file id), not from the sender.
- A proof is bound to its `index`: replaying a valid chunk+proof at a different
  index fails.
- `leafCount` must be the true chunk count; the carry logic desyncs otherwise.
- `computeLeafHash` output is domain-separated — storage adapters that precompute
  leaf hashes must use it, not a raw `crypto.subtle.digest`.

## Files

- `merkle-tree.ts` — implementation.
- `index.ts` — re-exports `merkle-tree.ts`.
- `merkle-tree.test.ts` — tests (build, proofs, tamper/index/root rejection,
  domain separation, duplication resistance, serialization round-trips,
  `processFile`/`processFileStreaming`).
