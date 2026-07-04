# Encryption Key Module

AES-GCM encryption for Y.js updates using the Web Crypto API.

## Overview

This module provides secure encryption and decryption of Y.js document updates using AES-256-GCM. It handles key generation, import/export, URL-fragment key sharing, and the encryption/decryption pipeline for binary update data.

## Required by default

Content-level end-to-end encryption is the **default** in Teleportal. Every `Provider` requires an `encryptionKey` (a `CryptoKey` produced by `createEncryptionKey()` or `importEncryptionKey()`); omitting it throws. To deliberately run a plaintext document, pass `encryptionKey: false`.

```ts
import { Provider } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

const provider = await Provider.create({
  url: "wss://example.com",
  document: "my-doc",
  encryptionKey: await createEncryptionKey(),
});
```

The key never reaches the server. To collaborate, share the exported key with other clients out-of-band — the URL fragment (hash) is a convenient channel because browsers never send it in requests (see [Sharing a Key via the URL Fragment](#sharing-a-key-via-the-url-fragment)).

## Usage

### Create an Encryption Key

```ts
import { createEncryptionKey } from "./index";

const key = await createEncryptionKey();
```

### Encrypt an Update

```ts
import { encryptUpdate } from "./index";

const encrypted = await encryptUpdate(key, update);
```

### Decrypt an Update

```ts
import { decryptUpdate } from "./index";

const decrypted = await decryptUpdate(key, encrypted);
```

### Deterministic Encryption (content-addressed file chunks)

```ts
import { createDeterministicEncryptor, decryptUpdate } from "./index";

const encrypt = await createDeterministicEncryptor(key);
// null if `key` is non-extractable — caller falls back to encryptUpdate.
const a = await encrypt!(chunk);
const b = await encrypt!(chunk); // byte-identical to `a`
await decryptUpdate(key, a); // unchanged; reads the IV from the first 12 bytes
```

`encryptUpdate` uses a fresh random IV per call — **always** use it for Y.js
updates. `createDeterministicEncryptor` derives the IV from the chunk content
via a keyed HMAC (`IV = HMAC-SHA-256(K_iv, chunk)[:12]`, `K_iv` = HKDF of the
key), so the same key + same chunk produces identical ciphertext. This is what
lets the file protocol content-address (and thus dedup and resume) encrypted
uploads by their Merkle root.

- **Keyed, not a plaintext hash.** Only key-holders can compute or confirm an
  IV. A naive `IV = SHA-256(chunk)` would let anyone holding the ciphertext
  confirm guessed plaintext without the key.
- **Nonce reuse here is safe.** A (key, IV) pair only ever recurs for identical
  plaintext, which yields identical ciphertext — no two-time-pad exposure.
- **Equality leak.** By construction, identical plaintext chunks are visibly
  identical ciphertext. Only acceptable for content-addressed file chunks, never
  for Y.js updates. See the [file protocol](../../protocols/file/README.md) for
  the full trade-off.
- **Cost.** The extra HMAC pass makes per-chunk encryption ~2–3× a random-IV
  encrypt single-threaded, but file chunks are encrypted in parallel so
  wall-clock impact is small.

### Export/Import Keys

Keys can be exported to a storable string format and imported later:

```ts
import { exportEncryptionKey, importEncryptionKey } from "./index";

// Export for storage
const keyString = await exportEncryptionKey(key);

// Import from storage
const importedKey = await importEncryptionKey(keyString);
```

### Sharing a Key via the URL Fragment

The canonical way to share an encryption key without it ever reaching the server is to keep it in the URL fragment (the part after `#`), which browsers never send in requests. `keyToUrlFragment` / `keyFromUrlFragment` serialize an exported key string to and from a fragment value.

```ts
import {
  createEncryptionKey,
  exportEncryptionKey,
  importEncryptionKey,
  keyToUrlFragment,
  keyFromUrlFragment,
} from "./index";

// --- Sharer: put the key in the link's fragment ---
const key = await createEncryptionKey();
location.hash = keyToUrlFragment(await exportEncryptionKey(key));
// → e.g. https://app.example.com/doc/123#token=<key>

// --- Recipient: read the key back from the fragment ---
const keyString = keyFromUrlFragment(location.hash); // string | null
const sharedKey = keyString ? await importEncryptionKey(keyString) : await createEncryptionKey();
```

`keyFromUrlFragment` accepts the raw `location.hash` (with or without a leading `#`) and returns `null` when no `token` is present.

### Key Resolvers

For multi-user key distribution, the `encryptionKey` option on `Provider.create` accepts a `KeyResolver` — an object that asynchronously resolves the key after the connection is ready. Two built-in resolvers are provided:

**Password-based** — derives a per-document key from a shared passphrase. No server involvement:

```ts
import { passwordKey } from "teleportal/encryption-key";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  encryptionKey: passwordKey("shared-passphrase"),
});
```

**Registry-based** — fetches a wrapped key from the server's key registry and unwraps it locally. See the [Key Registry Protocol](../protocols/key-registry/README.md) for the full setup:

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

### Key Wrapping

For server-side key management, utilities are provided for deriving per-user wrapping keys and wrapping/unwrapping document keys. These are used internally by the [Key Registry HTTP handlers](../protocols/key-registry/README.md) — you only need them for lower-level control.

```ts
import {
  deriveWrappingKey,
  wrapDocumentKey,
  unwrapDocumentKey,
  exportWrappingKey,
  importWrappingKey,
} from "teleportal/encryption-key";

// Derive a per-user wrapping key from the app's master secret
const wrappingKey = await deriveWrappingKey(masterSecret, userId);

// Wrap a document key for storage
const wrapped = await wrapDocumentKey(wrappingKey, documentKey);

// Unwrap it back
const unwrapped = await unwrapDocumentKey(wrappingKey, wrapped);

// Export/import for embedding in JWT claims
const keyString = await exportWrappingKey(wrappingKey);
const imported = await importWrappingKey(keyString);
```

## API

### Types

- `DecryptedBinary` - A Y.js update as a `Uint8Array`
- `EncryptedBinary` - An encrypted Y.js update as a `Uint8Array`
- `KeyResolver` - Async key resolution interface for `Provider.create`

### Functions

| Function                               | Description                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `createEncryptionKey()`                | Generates a new 256-bit AES-GCM `CryptoKey`                                     |
| `importEncryptionKey(keyString)`       | Imports a key from a JWK string                                                 |
| `exportEncryptionKey(key)`             | Exports a key to a JWK string                                                   |
| `keyToUrlFragment(keyString)`          | Serializes an exported key into a URL fragment value (`token=<key>`)            |
| `keyFromUrlFragment(hash)`             | Parses a key string out of a URL fragment (`string \| null`)                    |
| `encryptUpdate(key, data)`             | Encrypts a Y.js update (random IV)                                              |
| `decryptUpdate(key, encryptedBinary)`  | Decrypts an encrypted update                                                    |
| `createDeterministicEncryptor(key)`    | Keyed-IV encryptor for content-addressed chunks (`null` if key non-extractable) |
| `passwordKey(passphrase)`              | Returns a `KeyResolver` that derives per-document keys via PBKDF2               |
| `registryKey({ wrappingKey })`         | Returns a `KeyResolver` that fetches + unwraps from the key registry            |
| `deriveWrappingKey(secret, userId)`    | HKDF-SHA256 → AES-KW wrapping key, domain-separated per user                    |
| `wrapDocumentKey(wrappingKey, key)`    | AES-KW wrap → `Uint8Array` blob for storage                                     |
| `unwrapDocumentKey(wrappingKey, blob)` | AES-KW unwrap → usable `CryptoKey`                                              |
| `exportWrappingKey(key)`               | Export wrapping key to JWK string                                               |
| `importWrappingKey(keyString)`         | Import wrapping key from JWK string                                             |

## Security

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **IV**: 12-byte random IV generated for each encryption
- **Authentication**: GCM mode includes built-in authentication tag

Each encryption operation uses a unique random IV, ensuring that encrypting the same data produces different ciphertexts each time.

## Data Format

The encrypted output combines the IV and ciphertext:

```
[12-byte IV][...encrypted data with auth tag]
```

On decryption, the first 12 bytes are extracted as the IV, and the remainder is decrypted.
