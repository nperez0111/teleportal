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

## API

### Types

- `DecryptedBinary` - A Y.js update as a `Uint8Array`
- `EncryptedBinary` - An encrypted Y.js update as a `Uint8Array`

### Functions

| Function                              | Description                                                          |
| ------------------------------------- | -------------------------------------------------------------------- |
| `createEncryptionKey()`               | Generates a new 256-bit AES-GCM `CryptoKey`                          |
| `importEncryptionKey(keyString)`      | Imports a key from a JWK string                                      |
| `exportEncryptionKey(key)`            | Exports a key to a JWK string                                        |
| `keyToUrlFragment(keyString)`         | Serializes an exported key into a URL fragment value (`token=<key>`) |
| `keyFromUrlFragment(hash)`            | Parses a key string out of a URL fragment (`string \| null`)         |
| `encryptUpdate(key, data)`            | Encrypts a Y.js update                                               |
| `decryptUpdate(key, encryptedBinary)` | Decrypts an encrypted update                                         |

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
