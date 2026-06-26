const encoder = new TextEncoder();

/**
 * Derive a per-user wrapping key from the app's master secret via HKDF-SHA256.
 *
 * The info string is domain-separated: `"teleportal-kwk:{userId}"` so that
 * a leaked wrapping key for one user cannot be used to derive another's.
 */
export async function deriveWrappingKey(
  masterSecret: Uint8Array,
  userId: string,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(masterSecret) as any,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(`teleportal-kwk:${userId}`),
    },
    keyMaterial,
    { name: "AES-KW", length: 256 },
    true,
    ["wrapKey", "unwrapKey"],
  );
}

/**
 * Wrap a document encryption key (AES-256-GCM) using AES-KW (RFC 3394).
 * Returns the wrapped key blob for storage.
 */
export async function wrapDocumentKey(
  wrappingKey: CryptoKey,
  documentKey: CryptoKey,
): Promise<Uint8Array> {
  const wrapped = await crypto.subtle.wrapKey("raw", documentKey, wrappingKey, "AES-KW");
  return new Uint8Array(wrapped);
}

/**
 * Unwrap a document encryption key from a stored blob.
 * Returns a usable AES-256-GCM CryptoKey.
 */
export async function unwrapDocumentKey(
  wrappingKey: CryptoKey,
  wrappedKey: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    new Uint8Array(wrappedKey) as any,
    wrappingKey,
    "AES-KW",
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

/**
 * Export a wrapping key to a string suitable for embedding in a JWT claim.
 */
export async function exportWrappingKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("jwk", key);
  return exported.k!;
}

/**
 * Import a wrapping key from a string (e.g. extracted from a JWT claim).
 */
export async function importWrappingKey(keyString: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { k: keyString, alg: "A256KW", ext: true, key_ops: ["wrapKey", "unwrapKey"], kty: "oct" },
    { name: "AES-KW", length: 256 },
    true,
    ["wrapKey", "unwrapKey"],
  );
}
