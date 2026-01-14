# Encryption Key Module

AES-GCM encryption for Y.js updates using the Web Crypto API.

## Overview

This module provides secure encryption and decryption of Y.js document updates using AES-256-GCM. It handles key generation, import/export, and the encryption/decryption pipeline for binary update data.

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

## API

### Types

- `DecryptedBinary` - A Y.js update as a `Uint8Array`
- `EncryptedBinary` - An encrypted Y.js update as a `Uint8Array`

### Functions

| Function                              | Description                                 |
| ------------------------------------- | ------------------------------------------- |
| `createEncryptionKey()`               | Generates a new 256-bit AES-GCM `CryptoKey` |
| `importEncryptionKey(keyString)`      | Imports a key from a JWK string             |
| `exportEncryptionKey(key)`            | Exports a key to a JWK string               |
| `encryptUpdate(key, data)`            | Encrypts a Y.js update                      |
| `decryptUpdate(key, encryptedBinary)` | Decrypts an encrypted update                |

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
