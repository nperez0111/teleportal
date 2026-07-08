# `teleportal/encryption-key`

End-to-end encryption of Y.js updates (and file chunks) with AES-256-GCM over
the Web Crypto API, plus the key-management pieces around it: key derivation,
key **resolvers** (how a `Provider` obtains its key), and key **wrapping** (how a
server stores per-document keys wrapped per-user).

## Why it exists

Content-level E2EE is the **default** in Teleportal: the server relays and
stores only ciphertext and never sees plaintext or keys. This package is the
single place that owns the crypto primitives and the "where does the key come
from" abstraction (`KeyResolver`) used by `Provider.create`.

Because encryption is on by default, every `Provider` needs an `encryptionKey`.
Omitting it throws; to deliberately run a plaintext document pass
`encryptionKey: false`.

```ts
import { Provider } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

const provider = await Provider.create({
  url: "wss://example.com",
  document: "my-doc",
  encryptionKey: createEncryptionKey(), // a KeyResolver (see below)
});
```

## The two layers

### 1. Raw crypto (`index.ts`)

Operates on `CryptoKey`s directly.

- **`encryptUpdate(key, data)`** → `Uint8Array`. AES-256-GCM with a **fresh
  random 12-byte IV per call**. Output is `[12-byte IV][ciphertext+16-byte tag]`.
  Always use this for Y.js updates.
- **`decryptUpdate(key, blob)`** → `Uint8Array`. Rejects inputs shorter than 28
  bytes (12 IV + 16 tag) before touching the crypto, then AES-GCM decrypts;
  a bad tag/IV throws `"Decryption failed"`.
- **`generateEncryptionKey()`** → a fresh random extractable AES-GCM `CryptoKey`.
  Not derived from anything — different every call. Export & persist it yourself.
- **`importEncryptionKey(str)` / `exportEncryptionKey(key)`** — JWK `k` (base64url
  raw key) string ⇄ `CryptoKey`.
- **`keyToUrlFragment(str)` / `keyFromUrlFragment(hash)`** — serialize an exported
  key to/from a `token=<key>` URL-fragment value. The fragment (after `#`) is
  never sent to the server, making it the canonical out-of-band key channel.
  `keyFromUrlFragment` tolerates a leading `#` and returns `null` if absent.
- **`createDeterministicEncryptor(key)`** → an encrypt fn, or `null` if `key` is
  non-extractable. See [Deterministic encryption](#deterministic-encryption).

### 2. Key resolution (`key-resolver.ts`)

A `KeyResolver` is `{ resolve(ctx) → Promise<CryptoKey> }` (optionally
`onInvalidate`). `Provider.create` accepts one as `encryptionKey` and resolves it
after the connection is ready but before the provider is built. A single resolver
instance is reused across every document opened on the same connection, so
resolvers cache **per document**.

| Resolver                         | Key source                                                                           | Server involved |
| -------------------------------- | ------------------------------------------------------------------------------------ | --------------- |
| `simpleEncryption()`             | PBKDF2 over the **document ID** (salt `teleportal-simple-encryption-v1`, 100k iters) | no              |
| `passwordKey(passphrase)`        | PBKDF2 over the **passphrase** (salt `teleportal-pwd:<doc>`, 600k iters)             | no              |
| `createEncryptionKey(password?)` | Convenience wrapper: `password ? passwordKey(password) : simpleEncryption()`         | no              |
| `registryKey({ wrappingKey })`   | Fetches a wrapped key from the server via `keysGet` RPC, unwraps locally             | yes             |

`createEncryptionKey` is a **thin wrapper** — it delegates to `passwordKey` /
`simpleEncryption`, which are the single source of truth for the derivation
parameters. (Older docs described it as generating a random `CryptoKey`; it does
not — it returns a `KeyResolver`.)

#### `registryKey`

On first `resolve` for a document it sends an (encrypted) `keysGet` RPC, receives
`{ wrappedKey, generation }`, and unwraps `wrappedKey` with the supplied
`wrappingKey` (a `CryptoKey` or an async factory). The unwrapped key is cached
**per document**; a failed RPC/unwrap does **not** poison the cache. On key
rotation the key-registry extension calls the internal `_invalidate(document)`,
which drops only that document's cached key so the next `resolve` re-fetches.

```ts
import { registryKey, importWrappingKey } from "teleportal/encryption-key";
import { createKeyRegistryRpc } from "teleportal/protocols/key-registry";

const wrappingKey = await importWrappingKey(wrappingKeyFromJwt);
const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  encryptionKey: registryKey({ wrappingKey }),
  rpc: { keys: createKeyRegistryRpc },
});
```

### 3. Key wrapping (`key-wrapping.ts`)

Server-side helpers for the registry flow. Document keys are wrapped per-user so
storage only ever holds ciphertext of keys.

- **`deriveWrappingKey(masterSecret, userId)`** → an AES-KW `CryptoKey` via
  HKDF-SHA-256. `info` is domain-separated as `teleportal-kwk:<userId>`, so a
  leaked wrapping key for one user cannot derive another's. (Salt is empty by
  design — HKDF's `info` provides the separation.)
- **`wrapDocumentKey(wrappingKey, documentKey)`** → `Uint8Array` (AES-KW / RFC 3394).
- **`unwrapDocumentKey(wrappingKey, blob)`** → the AES-GCM `CryptoKey`. Throws if
  the wrapping key is wrong (AES-KW is authenticated).
- **`exportWrappingKey(key)` / `importWrappingKey(str)`** — JWK `k` string ⇄ key,
  suitable for embedding the wrapping key in a JWT claim delivered to the client.

## Deterministic encryption

`createDeterministicEncryptor(key)` builds an encryptor whose IV is
`HMAC-SHA-256(K_iv, chunk)[:12]`, where `K_iv` is HKDF-derived from `key`
(`info = "teleportal-file-iv"`). Consequences:

- **Same key + same chunk → byte-identical ciphertext**, so a Merkle tree over
  encrypted chunks is a stable content-addressed id (enables dedup and resume).
  Output framing is identical to `encryptUpdate`, so `decryptUpdate` reads it
  unchanged.
- **Keyed, not a plaintext hash.** Only key-holders can compute/confirm an IV. A
  naive `IV = SHA-256(chunk)` would let anyone holding the ciphertext confirm
  guessed plaintext.
- **Nonce reuse is safe here.** A `(key, IV)` pair only ever recurs for identical
  plaintext (⇒ identical ciphertext), so there is no two-time-pad exposure.
- **Equality leak — intended, scoped.** Identical plaintext chunks are visibly
  identical ciphertext. Acceptable **only** for content-addressed file chunks;
  never for Y.js updates. Use `encryptUpdate` (random IV) for updates.
- **Non-extractable keys.** The IV-derivation reads the raw key bytes, so a
  non-extractable `key` yields `null` — the caller falls back to `encryptUpdate`.
  The derived `K_iv` is cached per source key in a `WeakMap` (as a Promise, so
  concurrent callers share one derivation).

```ts
const encrypt = await createDeterministicEncryptor(key);
if (encrypt) {
  const a = await encrypt(chunk);
  const b = await encrypt(chunk); // byte-identical to `a`
  await decryptUpdate(key, a); // round-trips
}
```

## Sharing a key via the URL fragment

```ts
// Sharer
location.hash = keyToUrlFragment(await exportEncryptionKey(key));
// → https://app.example.com/doc/123#token=<key>

// Recipient
const s = keyFromUrlFragment(location.hash); // string | null
const key = s ? await importEncryptionKey(s) : createEncryptionKey();
```

## Security model

- **Cipher**: AES-256-GCM (authenticated). Key wrapping: AES-KW (RFC 3394).
- **IV**: random per call for `encryptUpdate`; keyed-deterministic for
  `createDeterministicEncryptor` (see above). 12 bytes, prepended to the output.
- **Key derivation**: PBKDF2-SHA-256 for the password/simple resolvers,
  HKDF-SHA-256 for wrapping keys and the deterministic IV key.
- **Server never sees keys or plaintext.** Keys reach clients out-of-band
  (URL fragment, passphrase) or wrapped-per-user (registry).
- **Ciphertext validation**: `decryptUpdate` rejects `< 28`-byte inputs up front.

### Gotchas

- `simpleEncryption()` / `createEncryptionKey()` (no password) derive the key
  from the **document ID alone** — anyone who knows the ID can decrypt. Only use
  when the ID itself is a secret (e.g. an unguessable UUID).
- `generateEncryptionKey()` returns a **new random key each call**; it is not
  derived and not shared. Persist/export it yourself or clients won't agree on a
  key.
- Deterministic encryption's equality leak makes it unsuitable for Y.js updates.

## Data format

```
[12-byte IV][AES-GCM ciphertext + 16-byte auth tag]
```

## Exports

Types: `DecryptedBinary`, `EncryptedBinary`, `KeyResolver`, `KeyResolverContext`.

Raw crypto: `encryptUpdate`, `decryptUpdate`, `createDeterministicEncryptor`,
`generateEncryptionKey`, `importEncryptionKey`, `exportEncryptionKey`,
`keyToUrlFragment`, `keyFromUrlFragment`.

Resolvers: `createEncryptionKey`, `simpleEncryption`, `passwordKey`, `registryKey`.

Wrapping: `deriveWrappingKey`, `wrapDocumentKey`, `unwrapDocumentKey`,
`exportWrappingKey`, `importWrappingKey`.
