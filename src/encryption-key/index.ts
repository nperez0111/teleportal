/**
 * The Y.js update, decrypted with AES-GCM
 */
export type DecryptedBinary = Uint8Array;
/**
 * The Y.js update, encrypted with AES-GCM
 */
export type EncryptedBinary = Uint8Array;

/**
 * Create an encryption key resolver for document encryption.
 *
 * **Without a password**: Derives a key from the document ID alone. This provides
 * minimal security — anyone who knows the document ID can decrypt the content.
 * Suitable for getting started quickly or when the document ID itself is secret
 * (e.g., a UUID shared only among authorized users).
 *
 * **With a password**: Derives a key from the password + document ID using PBKDF2.
 * All users with the same password can access the document. Good for "share a link
 * with a password" use cases.
 *
 * For production use cases with per-user access control, use `registryKey()` for
 * server-managed key distribution.
 *
 * @param password - Optional passphrase for password-based encryption
 * @returns A KeyResolver that derives consistent keys per document
 *
 * @example
 * ```ts
 * // Simple encryption (key derived from document ID)
 * const provider = await Provider.create({
 *   url: "wss://example.com",
 *   document: "my-doc",
 *   encryptionKey: createEncryptionKey(),
 * });
 *
 * // Password-based encryption
 * const provider = await Provider.create({
 *   url: "wss://example.com",
 *   document: "my-doc",
 *   encryptionKey: createEncryptionKey("my-secret-password"),
 * });
 * ```
 */
export function createEncryptionKey(password?: string): import("./key-resolver").KeyResolver {
  const encoder = new TextEncoder();
  const cache = new Map<string, CryptoKey>();

  return {
    async resolve({ document }): Promise<CryptoKey> {
      let key = cache.get(document);
      if (key) return key;

      if (password) {
        // Password-based key derivation
        const keyMaterial = await crypto.subtle.importKey(
          "raw",
          encoder.encode(password),
          "PBKDF2",
          false,
          ["deriveKey"],
        );
        key = await crypto.subtle.deriveKey(
          {
            name: "PBKDF2",
            salt: encoder.encode(`teleportal-pwd:${document}`),
            iterations: 600_000,
            hash: "SHA-256",
          },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
      } else {
        // Simple document-ID-based derivation
        const keyMaterial = await crypto.subtle.importKey(
          "raw",
          encoder.encode(document),
          "PBKDF2",
          false,
          ["deriveKey"],
        );
        key = await crypto.subtle.deriveKey(
          {
            name: "PBKDF2",
            salt: encoder.encode("teleportal-simple-encryption-v1"),
            iterations: 100_000,
            hash: "SHA-256",
          },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
      }

      cache.set(document, key);
      return key;
    },
  };
}

/**
 * Generate a random AES-GCM encryption key.
 *
 * **Warning**: This generates a new random key each time it's called. The key
 * is NOT derived from the document ID, so it will be different across sessions.
 * This is only suitable for:
 * - One-time use cases where the key is immediately shared via URL fragment
 * - Testing scenarios
 * - Cases where you'll export and persist the key yourself
 *
 * For most use cases, prefer `createEncryptionKey()` which derives consistent
 * keys per document.
 *
 * @returns A Promise that resolves to a random CryptoKey
 */
export async function generateEncryptionKey(): Promise<CryptoKey> {
  try {
    return await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true, // extractable
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    throw new Error(`Failed to generate encryption key: ${error}`);
  }
}

/**
 * Import an encryption key from a JWK string
 * @param keyString - The raw key data as string
 * @returns A Promise that resolves to a CryptoKey
 */
export async function importEncryptionKey(keyString: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      {
        k: keyString,
        alg: "A256GCM", // Use A256GCM to match the 256-bit key length
        ext: true,
        key_ops: ["encrypt", "decrypt"],
        kty: "oct",
      },
      { name: "AES-GCM", length: 256 },
      true, // extractable - keep consistent with generated keys
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    throw new Error(`Failed to import encryption key: ${error}`);
  }
}

/**
 * Export an encryption key to a JWK string
 * @param key - The CryptoKey to export
 * @returns A Promise that resolves to the key string
 */
export async function exportEncryptionKey(key: CryptoKey): Promise<string> {
  try {
    const exported = await crypto.subtle.exportKey("jwk", key);
    return exported.k!;
  } catch (error) {
    throw new Error(`Failed to export encryption key: ${error}`);
  }
}

/**
 * Serialize an exported key string into a URL fragment (hash) value.
 *
 * The canonical way to share an end-to-end encryption key without it ever
 * reaching the server is to keep it in the URL fragment, which browsers never
 * send in requests. Pair with {@link exportEncryptionKey}:
 *
 * ```ts
 * location.hash = keyToUrlFragment(await exportEncryptionKey(key));
 * ```
 *
 * @param keyString - An exported key string (from {@link exportEncryptionKey})
 * @returns The fragment value (without a leading `#`), e.g. `token=<key>`
 */
export function keyToUrlFragment(keyString: string): string {
  return new URLSearchParams({ token: keyString }).toString();
}

/**
 * Parse an exported key string out of a URL fragment (hash) value.
 *
 * Accepts the raw `location.hash` (with or without a leading `#`). Pass the
 * result to {@link importEncryptionKey} to rebuild the {@link CryptoKey}.
 *
 * @param hash - A URL fragment such as `#token=<key>` or `token=<key>`
 * @returns The key string, or `null` if no `token` is present
 */
export function keyFromUrlFragment(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(value).get("token");
}

/**
 * Encrypt a Y.js update using AES-GCM
 * @param key - The encryption key to use
 * @param data - The update to encrypt
 * @returns The encrypted update as a Uint8Array
 */
export async function encryptUpdate(
  key: CryptoKey,
  data: DecryptedBinary,
): Promise<EncryptedBinary> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encryptedData = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data as BufferSource,
    );

    const result = new Uint8Array(12 + encryptedData.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encryptedData), 12);

    return result as EncryptedBinary;
  } catch (error) {
    throw new Error(`Encryption failed: ${error}`);
  }
}

/**
 * Cache of derived IV-derivation keys, keyed by the source AES-GCM key. The
 * value is `null` when the key is non-extractable (deterministic mode is
 * unavailable for it). Cached as a Promise so concurrent callers share one
 * derivation. Mirrors the keyed-tokenizer WeakMap cache in the encryption path.
 */
const ivKeyCache = new WeakMap<CryptoKey, Promise<CryptoKey | null>>();

/**
 * Derive an HMAC-SHA-256 key used to compute deterministic IVs from chunk
 * content, from an AES-GCM key. Returns `null` when the key is non-extractable
 * (its raw bytes can't be read, so no derivation is possible).
 */
function getIvDerivationKey(key: CryptoKey): Promise<CryptoKey | null> {
  const cached = ivKeyCache.get(key);
  if (cached) {
    return cached;
  }

  const derived = (async (): Promise<CryptoKey | null> => {
    let rawKey: ArrayBuffer;
    try {
      rawKey = await crypto.subtle.exportKey("raw", key);
    } catch {
      // Non-extractable key — deterministic mode unavailable.
      return null;
    }

    // HKDF import must be non-extractable per the Web Crypto spec.
    const hkdfKey = await crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveKey"]);

    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        // salt is a required BufferSource (empty is fine); info domain-separates
        // this derivation from any other use of the same key material.
        salt: new Uint8Array(0),
        info: new TextEncoder().encode("teleportal-file-iv"),
      },
      hkdfKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  })();

  ivKeyCache.set(key, derived);
  return derived;
}

/**
 * Build a deterministic AES-GCM chunk encryptor for `key`, or `null` when the
 * key is non-extractable (the caller then falls back to random-IV
 * {@link encryptUpdate}).
 *
 * The IV is `HMAC-SHA-256(K_iv, chunk)[0..12)`, where `K_iv` is derived from
 * `key` via HKDF. Because the derivation is keyed, only key-holders (who can
 * already decrypt the content) can compute or confirm an IV — a plaintext hash
 * would instead let anyone holding the ciphertext confirm guessed content.
 *
 * Same `key` + same `chunk` → identical ciphertext, which makes a merkle tree
 * over encrypted chunks a stable content-addressed id (enabling dedup and
 * resume). This equality is intended ONLY for content-addressed file chunks;
 * never use it for Y.js updates (use {@link encryptUpdate}, which uses a random
 * IV per call).
 *
 * Reusing a (key, IV) pair is safe here: it only ever recurs for identical
 * plaintext, which produces identical ciphertext (no two-time-pad exposure).
 *
 * @param key - The AES-GCM encryption key
 * @returns An encrypt function, or `null` if `key` is non-extractable
 */
export async function createDeterministicEncryptor(
  key: CryptoKey,
): Promise<((data: DecryptedBinary) => Promise<EncryptedBinary>) | null> {
  const ivKey = await getIvDerivationKey(key);
  if (!ivKey) {
    return null;
  }

  return async (data: DecryptedBinary): Promise<EncryptedBinary> => {
    try {
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", ivKey, data as BufferSource));
      const iv = mac.subarray(0, 12);

      const encryptedData = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        data as BufferSource,
      );

      const result = new Uint8Array(12 + encryptedData.byteLength);
      result.set(iv, 0);
      result.set(new Uint8Array(encryptedData), 12);

      return result as EncryptedBinary;
    } catch (error) {
      throw new Error(`Deterministic encryption failed: ${error}`);
    }
  };
}

/**
 * Decrypt a Y.js update using AES-GCM
 * @param key - The decryption key to use
 * @param encryptedBinary - The encrypted update to decrypt
 * @returns The decrypted update as a Uint8Array
 */
export async function decryptUpdate(
  key: CryptoKey,
  encryptedBinary: EncryptedBinary,
): Promise<DecryptedBinary> {
  // 12-byte IV + 16-byte GCM auth tag minimum
  if (encryptedBinary.byteLength < 28) {
    throw new Error("Decryption failed: ciphertext too short");
  }

  try {
    const iv = encryptedBinary.subarray(0, 12) as Uint8Array<ArrayBuffer>;
    const encryptedData = encryptedBinary.subarray(12) as Uint8Array<ArrayBuffer>;
    const decryptedData = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedData);

    return new Uint8Array(decryptedData);
  } catch (error) {
    throw new Error(`Decryption failed: ${error}`);
  }
}

export * from "./key-wrapping";
export * from "./key-resolver";
