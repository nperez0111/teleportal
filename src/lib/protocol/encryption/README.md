# Encryption Protocol

Content-level encryption for Y.js updates, and the **default** mode for Teleportal documents. Encrypts document **content** while preserving CRDT **metadata** in plaintext. This allows the server to merge updates, compute state vectors, and perform sync — while the actual text, values, embeds, and formatting remain encrypted. The `Provider` applies this automatically; pass `encryptionKey: false` to opt a document out into plaintext.

The server stores V2 updates internally for both encrypted and unencrypted documents. For encrypted documents, V1 structure updates are used on the wire (for `stripContent`/`restoreContent`), with V1↔V2 conversion happening at the storage boundary.

## What leaks vs. what's encrypted

| Leaked (plaintext)                                             | Encrypted (sidecar)                     |
| -------------------------------------------------------------- | --------------------------------------- |
| Client IDs, clocks, logical timestamps                         | Text strings (`ContentString`)          |
| Item origins (left/right), parent references                   | Map/array values (`ContentAny`)         |
| Content type (text vs. embed vs. format), item count           | Embeds (`ContentEmbed`)                 |
| Delete sets (which items were deleted)                         | Format key + value (`ContentFormat`)    |
| Shared type structure (`ContentType` — YText, YMap, YArray...) | JSON values (`ContentJSON`)             |
| Parent key names (map keys like `"title"`, `"body"`)           | Binary data (`ContentBinary`)           |
|                                                                | Sub-document identifiers (`ContentDoc`) |

## How it works

1. **Strip**: Parse a Y.js V1 update, replace content with deterministic placeholders, extract original content into a sidecar keyed by `(clientId, clock)`.
2. **Encrypt**: AES-256-GCM encrypt the sidecar.
3. **Store/Sync**: The server converts V1 → V2 for storage, then uses `Y.mergeUpdatesV2`/`Y.diffUpdateV2` — the same operations used for unencrypted documents.
4. **Sync wire format**: On sync, the server converts V2 → V1, filters relevant sidecars, and wraps in a `ContentEncryptedPayload`.
5. **Decrypt**: Client decrypts the sidecar, splices original content back into the V1 structure update.

## Usage

```ts
import { createEncryptionKey } from "teleportal/encryption-key";
import { encryptUpdateContent, decryptUpdateContent } from "teleportal/protocol/encryption";

const key = await createEncryptionKey();

// Encrypt a V1 update
const encrypted = await encryptUpdateContent(key, v1Update, 1);
// encrypted.structureUpdate — valid Y.js V1 update (server can merge this)
// encrypted.encryptedSidecar — AES-GCM encrypted content

// Decrypt
const original = await decryptUpdateContent(key, encrypted, 1);

// V2 is also supported
const encryptedV2 = await encryptUpdateContent(key, v2Update, 2);
const originalV2 = await decryptUpdateContent(key, encryptedV2, 2);
```

## Low-level API

For custom storage or transport, use the low-level functions:

```ts
import {
  stripContent,
  restoreContent,
  encodeSidecar,
  decodeSidecar,
} from "teleportal/protocol/encryption";

// Strip content from a V1 update
const { update: structureUpdate, sidecar } = stripContent(v1Update);

// Encode sidecar for storage/encryption
const sidecarBytes = encodeSidecar(sidecar);

// Later: decode and restore
const restoredSidecar = decodeSidecar(sidecarBytes);
const originalUpdate = restoreContent(structureUpdate, restoredSidecar);
```

## Sidecar index (server-side filtering)

Each encrypted sidecar is stored alongside a plaintext **index** — a list of
`(clientId, minClock, maxClock)` ranges describing which CRDT items the sidecar
covers. The index is derived from `Y.parseUpdateMeta()` on the structure update
and leaks no additional information (client IDs and clocks are already visible in
the plaintext structure update).

On `handleSyncStep1`, the server computes `Y.diffUpdateV2()` for the reconnecting
client, converts the diff to V1, then filters sidecars using the index. Only
sidecars whose clock ranges overlap the diff are sent.

```ts
import {
  buildSidecarIndex,
  buildSidecarIndexFromUpdateMeta,
  sidecarOverlapsDiff,
} from "teleportal/protocol/encryption";

// Build index from content entries (client-side, before encryption)
const index = buildSidecarIndex(entries);

// Or derive from a structure update's metadata (server-side)
const meta = Y.parseUpdateMeta(structureUpdate);
const index = buildSidecarIndexFromUpdateMeta(meta);

// Filter sidecars for a diff
const diffMeta = Y.parseUpdateMeta(diff);
const relevant = sidecars.filter((s) => sidecarOverlapsDiff(s.index, diffMeta));
```

## Compaction

Sidecars accumulate over time (one per update). The storage layer supports
**compaction** via `handleCompaction(key, compactedSidecar, baseSV)`, which
atomically replaces all sidecars with a single compacted one. Optimistic
concurrency is enforced via `baseSV` — if the document state has changed since
the caller read the sidecars, the compaction is rejected.

A connected client can compact after sync: decrypt all sidecars, merge entries
(deduplicating by `clientId:clock`), re-encrypt as one sidecar, and send back to
the server.

## Sidecar binary format

Column-based encoding, grouped by client:

```
[version=0] [numClients]
per client group:
  [clientId] [numEntries]
  [clocks as IntDiffOptRle bytes (varUint8Array)]
  [contentRefs as UintOptRle bytes (varUint8Array)]
  [data lengths as UintOptRle bytes (varUint8Array)]
  [concatenated data (raw bytes, length = sum of data lengths)]
```

## Wire format (ContentEncryptedPayload)

```
[version=2]
[structureUpdate as varUint8Array]   — V1 update with placeholder content
[numSidecars as varUint]
per sidecar: [sidecar as varUint8Array]   — AES-GCM encrypted content
```
