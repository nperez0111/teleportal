# Encrypted transport

Import path: `teleportal/transports` (`getEncryptedTransport`, `EncryptionClient`)

End-to-end **content** encryption layered on the [YDoc transport](../ydoc). The
server stores the document's _structure_ (shape) in the clear alongside opaque
encrypted **sidecars** holding the actual text/data. Only a client with the
correct `CryptoKey` can restore full content; the server can still merge,
persist, and fan out updates without ever seeing content.

```ts
import { getEncryptedTransport, EncryptionClient } from "teleportal/transports";

const client = new EncryptionClient({ document: "my-doc", key /* CryptoKey */ });
const transport = getEncryptedTransport(client);

await transport.handler.start(); // encrypted sync handshake
await transport.synced; // resolves on sync-done
```

## How a message is split

For each Y.js update the client runs `stripContent(update, version, tokenizer)`,
producing:

- a **structure update** — the CRDT skeleton with content removed (sent in the
  clear, stored server-side), and
- a **sidecar** — the removed content, encrypted with the document key.

Both are packed into the content-encrypted envelope
(`encodeContentEncryptedPayload`), which is the same wire/disk format the plain
YDoc transport emits (with empty sidecars) — so encrypted and cleartext
documents are storage-compatible.

The tokenizer is keyed by the raw document key (`createKeyedTokenizer`) and
cached; it is what makes content stripping deterministic across clients.

## Handshake & incremental updates

`EncryptionClient` implements both YDoc handler interfaces:

- `start()` → `sync-step-1` with the local state vector.
- `handleSyncStep1(sv)` → encrypted `sync-step-2` (local diff, stripped +
  encrypted).
- `handleSyncStep2` / `handleUpdate` → decrypt sidecars, `restoreContent`, apply
  under the sync-transaction origin (so it isn't re-emitted).
- `onUpdate` → encrypt a local edit into an outgoing message.
- Awareness updates are encrypted/decrypted transparently.

A decrypt failure raises a descriptive error (wrong/changed key or corrupt data)
rather than silently applying a broken update.

## Sidecar compaction

Every applied/produced update appends a sidecar; unbounded, the server would
accumulate one sidecar per edit forever. Once `COMPACTION_THRESHOLD` (25)
sidecars have accumulated, a **background** task merges them into a single
`IndexedSidecar`. It is stashed in `#pendingCompaction` and piggybacks on the
next outgoing message (`handleSyncStep1` / `onUpdate`) via `#takeReadyCompaction`
— the protocol treats a compaction as optional, so a send simply omits it if
none is ready. Only one compaction runs at a time (`#compactionInFlight`).

Outgoing sidecars are accumulated **after** the payload is built, because the
compaction that references a sidecar must run only once the server has stored it.

`destroy()` clears the cached tokenizer, any pending compaction, and the sidecar
buffer; it is invoked by the YDoc source teardown.
</content>
