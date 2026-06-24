/**
 * The Y.js update, decrypted with AES-GCM
 */
export type DecryptedBinary = Uint8Array;
/**
 * The Y.js update, encrypted with AES-GCM
 */
export type EncryptedBinary = Uint8Array;

/**
 * Generate a new AES-GCM encryption key
 * @returns A Promise that resolves to a CryptoKey
 */
export async function createEncryptionKey(): Promise<CryptoKey> {
  try {
    return await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, // Use 256-bit key for better security
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
    // Generate a random IV (Initialization Vector) for each encryption
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes for AES-GCM

    // Encrypt the update
    const encryptedData = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      new Uint8Array(data),
    );

    // Combine IV and encrypted data (which includes the authentication tag)
    const result = new Uint8Array(iv.length + encryptedData.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encryptedData), iv.length);

    return result as EncryptedBinary;
  } catch (error) {
    throw new Error(`Encryption failed: ${error}`);
  }
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
  try {
    // Extract IV (first 12 bytes) and encrypted data (which includes auth tag)
    const iv = encryptedBinary.slice(0, 12);
    const encryptedData = encryptedBinary.slice(12);

    // Decrypt the data
    const decryptedData = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedData);

    return new Uint8Array(decryptedData);
  } catch (error) {
    throw new Error(`Decryption failed: ${error}`);
  }
}
