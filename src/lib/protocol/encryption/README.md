# Encryption Protocol

Content-level encryption for Y.js updates, and the **default** mode for Teleportal documents. Encrypts document **content** while preserving CRDT **metadata** in plaintext. This allows the server to merge updates, compute state vectors, and perform sync — while the actual text, values, embeds, and formatting remain encrypted. The `Provider` applies this automatically; pass `encryptionKey: false` to opt a document out into plaintext.

The server stores V2 updates internally for both encrypted and unencrypted documents. `stripContent` accepts V1 or V2 input and always outputs a V2 structure update (with tokenized metadata). A V1 fast path (`tokenize: false`) is available for unencrypted documents that bypasses Y.js decoders entirely.

## What leaks vs. what's encrypted

| Leaked (plaintext)                                             | Encrypted (sidecar)                     |
| -------------------------------------------------------------- | --------------------------------------- |
| Client IDs, clocks, logical timestamps                         | Text strings (`ContentString`)          |
| Item origins (left/right), parent references                   | Map/array values (`ContentAny`)         |
| Content type (text vs. embed vs. format), item count           | Embeds (`ContentEmbed`)                 |
| Delete sets (which items were deleted)                         | Format key + value (`ContentFormat`)    |
| Shared type structure (`ContentType` — YText, YMap, YArray...) | JSON values (`ContentJSON`)             |
| Item **lengths** (placeholders preserve exact item size)       | Binary data (`ContentBinary`)           |
| Map-key **reuse** (same key → same opaque token)               | Map/format key names (keyed-tokenized)  |
|                                                                | Sub-document identifiers (`ContentDoc`) |

Map and format key names (e.g. `"title"`, `"body"`) are **not** sent in the
clear. They are replaced by an opaque token in the structure update, and the
token→name mapping travels in the encrypted sidecar dictionary. The token is a
keyed PRF — `HMAC-SHA256(documentKey, name)` truncated to 128 bits — so it is
deterministic within a document (the server can still merge edits to the same
key) but **not** guessable: a server cannot confirm a key is `"title"` by
hashing the guess, the way an unkeyed hash would allow.

## Threat model

The server is treated as **honest-but-curious without the key**. It cannot read
content, but the plaintext structure update is a real Y.js update, so the server
**can infer**: the document's CRDT shape (clients, causal order, type tree),
**how large each edit is** (item lengths are preserved exactly — e.g. it learns
a text insertion was 12 characters), **when** edits happen, deletion patterns,
and which edits touch the same (tokenized) map key. It cannot recover text,
values, embeds, formatting values, or key names. Length and structure leakage is
inherent to letting the server run CRDT merge/diff without the key — an item's
length **is** its clock span, so it cannot be hidden while keeping the structure
update mergeable. Choose this mode when "server learns structure and edit sizes,
never content" is an acceptable trade; it is not a metadata-private design.

## How it works

1. **Strip**: Parse a Y.js update (V1 or V2), replace content with deterministic placeholders, extract original content into a sidecar keyed by `(clientId, clock)`. Metadata strings are replaced with keyed tokens.
2. **Encrypt**: AES-256-GCM encrypt the sidecar.
3. **Store/Sync**: The server stores the V2 structure update and uses `Y.mergeUpdatesV2`/`Y.diffUpdateV2` -- the same operations used for unencrypted documents.
4. **Sync wire format**: On sync, the server filters relevant sidecars by their index and wraps the diff + sidecars in a `ContentEncryptedPayload`.
5. **Decrypt**: Client decrypts the sidecar(s), reverses the token dictionary, and splices original content back into the structure update via `restoreContent`.

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

Column-based encoding with a metadata dictionary followed by client-grouped entries:

```
[version=0 as varUint]
[numDictEntries as varUint]
per entry: [token as varString] [original as varString]
[numClientGroups as varUint]
per client group:
  [clientId as varUint] [numEntries as varUint]
  [clocks as IntDiffOptRle bytes (varUint8Array)]
  [contentRefs as UintOptRle bytes (varUint8Array)]
  [itemLengths as UintOptRle bytes (varUint8Array)]
  [data lengths as UintOptRle bytes (varUint8Array)]
  [totalDataLen as varUint]
  [concatenated data (raw bytes, length = totalDataLen)]
```

## Wire format (ContentEncryptedPayload)

```
[version=1 as varUint]
[structureUpdate as varUint8Array]   -- V2 update with placeholder content
[numSidecars as varUint]
per sidecar: [sidecar as varUint8Array]   -- AES-GCM encrypted content
[hasCompaction as uint8]             -- 0 or 1
if hasCompaction == 1:
  [compactedSidecar as varUint8Array]
  [numIndexEntries as varUint]
  per entry: [clientId as varUint] [minClock as varUint] [maxClock as varUint]
  [compactedHash as varUint8Array]
  [numSourceHashes as varUint]
  per sourceHash: [hash as varUint8Array]
```
