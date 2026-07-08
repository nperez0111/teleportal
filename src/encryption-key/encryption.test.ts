import { describe, expect, it } from "bun:test";
import {
  createEncryptionKey,
  generateEncryptionKey,
  createDeterministicEncryptor,
  importEncryptionKey,
  exportEncryptionKey,
  encryptUpdate,
  decryptUpdate,
  keyToUrlFragment,
  keyFromUrlFragment,
} from "./index";
import type { Update } from "teleportal";

// Helper function to create a proper Update type
function createUpdate(data: Uint8Array): Update {
  return data as Update;
}

describe("Encryption Functions", () => {
  it("should encrypt and decrypt an update successfully", async () => {
    const key = await generateEncryptionKey();
    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

    // Encrypt the update
    const encrypted = await encryptUpdate(key, testUpdate);

    // Verify the encrypted data is different from the original
    expect(encrypted).not.toEqual(testUpdate);
    expect(encrypted.length).toBeGreaterThan(testUpdate.length);

    // Decrypt the update
    const decrypted = await decryptUpdate(key, encrypted);

    // Verify the decrypted data matches the original
    expect(decrypted).toEqual(testUpdate);
  });

  it("should handle empty updates", async () => {
    const key = await generateEncryptionKey();
    const emptyUpdate = createUpdate(new Uint8Array(0));

    const encrypted = await encryptUpdate(key, emptyUpdate);
    const decrypted = await decryptUpdate(key, encrypted);

    expect(decrypted).toEqual(emptyUpdate);
  });

  it("should handle large updates", async () => {
    const key = await generateEncryptionKey();
    const largeUpdate = new Uint8Array(1000);
    for (let i = 0; i < largeUpdate.length; i++) {
      largeUpdate[i] = i % 256;
    }

    const encrypted = await encryptUpdate(key, createUpdate(largeUpdate));
    const decrypted = await decryptUpdate(key, encrypted);

    expect(decrypted).toEqual(createUpdate(largeUpdate));
  });

  it("should export and import keys correctly", async () => {
    // Create a key and encrypt something
    const key = await generateEncryptionKey();
    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));
    const encrypted = await encryptUpdate(key, testUpdate);

    // Export the key
    const exportedKeyString = await exportEncryptionKey(key);
    expect(exportedKeyString).toBeDefined();
    expect(typeof exportedKeyString).toBe("string");

    // Import the key
    const importedKey = await importEncryptionKey(exportedKeyString);

    // Test that decryption still works with the imported key
    const decrypted = await decryptUpdate(importedKey, encrypted);

    expect(decrypted).toEqual(testUpdate);
  });

  it("should handle multiple consecutive operations", async () => {
    const key = await generateEncryptionKey();
    const updates = [
      createUpdate(new Uint8Array([1, 2, 3])),
      createUpdate(new Uint8Array([4, 5, 6])),
      createUpdate(new Uint8Array([7, 8, 9])),
    ];

    const encrypted = await Promise.all(updates.map((update) => encryptUpdate(key, update)));

    const decrypted = await Promise.all(encrypted.map((enc) => decryptUpdate(key, enc)));

    expect(decrypted).toEqual(updates);
  });

  it("should generate different encrypted outputs for the same input", async () => {
    const key = await generateEncryptionKey();
    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

    const encrypted1 = await encryptUpdate(key, testUpdate);
    const encrypted2 = await encryptUpdate(key, testUpdate);

    // The encrypted outputs should be different due to random IV
    expect(encrypted1).not.toEqual(encrypted2);

    // But both should decrypt to the same original data
    const decrypted1 = await decryptUpdate(key, encrypted1);
    const decrypted2 = await decryptUpdate(key, encrypted2);

    expect(decrypted1).toEqual(testUpdate);
    expect(decrypted2).toEqual(testUpdate);
  });

  it("never reuses the random IV across many encryptions of the same data", async () => {
    // Nonce reuse is catastrophic for AES-GCM. Assert the 12-byte IV prefix is
    // unique across a batch of encryptions of identical plaintext.
    const key = await generateEncryptionKey();
    const data = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));
    const N = 200;
    const ivs = new Set<string>();
    for (let i = 0; i < N; i++) {
      const enc = await encryptUpdate(key, data);
      ivs.add(Buffer.from(enc.subarray(0, 12)).toString("hex"));
    }
    expect(ivs.size).toBe(N);
  });

  it("decryptUpdate error message does not leak key material", async () => {
    const key = await generateEncryptionKey();
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const keyHex = Buffer.from(rawKey).toString("hex");

    const enc = await encryptUpdate(key, new Uint8Array([1, 2, 3]));
    enc[enc.length - 1] ^= 0xff; // corrupt the auth tag
    let message = "";
    try {
      await decryptUpdate(key, enc);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("Decryption failed");
    expect(message).not.toContain(keyHex);
  });

  it("should handle multiple keys independently", async () => {
    const key1 = await generateEncryptionKey();
    const key2 = await generateEncryptionKey();
    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

    // Encrypt with key1
    const encrypted1 = await encryptUpdate(key1, testUpdate);

    // Encrypt with key2
    const encrypted2 = await encryptUpdate(key2, testUpdate);

    // The encrypted outputs should be different
    expect(encrypted1).not.toEqual(encrypted2);

    // Decrypt with respective keys
    const decrypted1 = await decryptUpdate(key1, encrypted1);
    const decrypted2 = await decryptUpdate(key2, encrypted2);

    expect(decrypted1).toEqual(testUpdate);
    expect(decrypted2).toEqual(testUpdate);

    // Try to decrypt with wrong key - should fail
    await expect(decryptUpdate(key2, encrypted1)).rejects.toThrow();
    await expect(decryptUpdate(key1, encrypted2)).rejects.toThrow();
  });

  it("should create unique keys", async () => {
    const key1 = await generateEncryptionKey();
    const key2 = await generateEncryptionKey();

    const exported1 = await exportEncryptionKey(key1);
    const exported2 = await exportEncryptionKey(key2);

    // Keys should be different
    expect(exported1).not.toEqual(exported2);
  });

  it("should work with imported keys from different sources", async () => {
    // Create two different keys
    const key1 = await generateEncryptionKey();
    const key2 = await generateEncryptionKey();

    // Export both keys
    const exported1 = await exportEncryptionKey(key1);
    const exported2 = await exportEncryptionKey(key2);

    // Import them back
    const imported1 = await importEncryptionKey(exported1);
    const imported2 = await importEncryptionKey(exported2);

    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

    // Test that imported keys work correctly
    const encrypted1 = await encryptUpdate(imported1, testUpdate);
    const encrypted2 = await encryptUpdate(imported2, testUpdate);

    const decrypted1 = await decryptUpdate(imported1, encrypted1);
    const decrypted2 = await decryptUpdate(imported2, encrypted2);

    expect(decrypted1).toEqual(testUpdate);
    expect(decrypted2).toEqual(testUpdate);

    // Cross-decryption should fail
    await expect(decryptUpdate(imported2, encrypted1)).rejects.toThrow();
    await expect(decryptUpdate(imported1, encrypted2)).rejects.toThrow();
  });
});

describe("URL fragment key helpers", () => {
  it("round-trips an exported key through a URL fragment", async () => {
    const key = await generateEncryptionKey();
    const exported = await exportEncryptionKey(key);

    const fragment = keyToUrlFragment(exported);
    expect(fragment.startsWith("token=")).toBe(true);

    // Tolerate a leading "#" as returned by location.hash.
    expect(keyFromUrlFragment(fragment)).toBe(exported);
    expect(keyFromUrlFragment("#" + fragment)).toBe(exported);

    // The recovered string re-imports to a working key.
    const recovered = await importEncryptionKey(keyFromUrlFragment(fragment)!);
    const data = new Uint8Array([1, 2, 3]);
    const ciphertext = await encryptUpdate(key, data as Update);
    expect(await decryptUpdate(recovered, ciphertext)).toEqual(data);
  });

  it("returns null when no token is present", () => {
    expect(keyFromUrlFragment("")).toBeNull();
    expect(keyFromUrlFragment("#")).toBeNull();
    expect(keyFromUrlFragment("#other=value")).toBeNull();
  });

  it("ignores other fragment params", () => {
    expect(keyFromUrlFragment("#a=1&token=abc&b=2")).toBe("abc");
  });
});

describe("createDeterministicEncryptor", () => {
  const sha256 = async (data: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));

  it("produces identical ciphertext for the same key and chunk", async () => {
    const key = await generateEncryptionKey();
    const encrypt = await createDeterministicEncryptor(key);
    expect(encrypt).not.toBeNull();

    const chunk = new Uint8Array([1, 2, 3, 4, 5]);
    const a = await encrypt!(chunk);
    const b = await encrypt!(chunk);
    expect(a).toEqual(b);
  });

  it("round-trips through the unchanged decryptUpdate", async () => {
    const key = await generateEncryptionKey();
    const encrypt = await createDeterministicEncryptor(key);

    const chunk = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const ciphertext = await encrypt!(chunk);
    expect(await decryptUpdate(key, ciphertext)).toEqual(chunk);
  });

  it("differs across chunks and across keys", async () => {
    const key1 = await generateEncryptionKey();
    const key2 = await generateEncryptionKey();
    const e1 = await createDeterministicEncryptor(key1);
    const e2 = await createDeterministicEncryptor(key2);

    const chunkA = new Uint8Array([1, 2, 3]);
    const chunkB = new Uint8Array([4, 5, 6]);

    expect(await e1!(chunkA)).not.toEqual(await e1!(chunkB));
    // Same chunk under a different key must differ (per-key dedup scope).
    expect(await e1!(chunkA)).not.toEqual(await e2!(chunkA));
  });

  it("uses a KEYED IV, not the raw SHA-256 of the chunk", async () => {
    const key = await generateEncryptionKey();
    const encrypt = await createDeterministicEncryptor(key);

    const chunk = new Uint8Array([1, 1, 1, 1]);
    const ciphertext = await encrypt!(chunk);
    const iv = ciphertext.subarray(0, 12);

    // A naive implementation would set iv = SHA-256(chunk)[:12], which would let
    // anyone holding the ciphertext confirm guessed plaintext. Assert it does not.
    const naiveIv = (await sha256(chunk)).subarray(0, 12);
    expect(iv).not.toEqual(naiveIv);
  });

  it("handles empty chunks deterministically", async () => {
    const key = await generateEncryptionKey();
    const encrypt = await createDeterministicEncryptor(key);

    const empty = new Uint8Array(0);
    const a = await encrypt!(empty);
    const b = await encrypt!(empty);
    expect(a).toEqual(b);
    expect(await decryptUpdate(key, a)).toEqual(empty);
  });

  it("returns null for a non-extractable key", async () => {
    const nonExtractable = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    expect(await createDeterministicEncryptor(nonExtractable)).toBeNull();
  });
});

describe("decryptUpdate edge cases", () => {
  it("should reject ciphertext shorter than IV + auth tag (28 bytes)", async () => {
    const key = await generateEncryptionKey();
    await expect(decryptUpdate(key, new Uint8Array(27))).rejects.toThrow("ciphertext too short");
    await expect(decryptUpdate(key, new Uint8Array(0))).rejects.toThrow("ciphertext too short");
    await expect(decryptUpdate(key, new Uint8Array(12))).rejects.toThrow("ciphertext too short");
  });

  it("should reject ciphertext with a corrupted auth tag", async () => {
    const key = await generateEncryptionKey();
    const data = new Uint8Array([1, 2, 3]);
    const encrypted = await encryptUpdate(key, data);

    // Flip a byte in the auth tag (last 16 bytes)
    encrypted[encrypted.length - 1] ^= 0xff;
    await expect(decryptUpdate(key, encrypted)).rejects.toThrow("Decryption failed");
  });

  it("should reject ciphertext with a corrupted IV", async () => {
    const key = await generateEncryptionKey();
    const data = new Uint8Array([1, 2, 3]);
    const encrypted = await encryptUpdate(key, data);

    encrypted[0] ^= 0xff;
    await expect(decryptUpdate(key, encrypted)).rejects.toThrow("Decryption failed");
  });
});

describe("importEncryptionKey edge cases", () => {
  it("should reject an invalid key string", async () => {
    await expect(importEncryptionKey("not-valid-base64url!")).rejects.toThrow();
  });
});

describe("createEncryptionKey", () => {
  it("should derive a consistent key for the same document (no password)", async () => {
    const resolver1 = createEncryptionKey();
    const resolver2 = createEncryptionKey();

    const key1 = await resolver1.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver2.resolve({ document: "doc-1", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).toBe(exported2.k);
  });

  it("should derive different keys for different documents (no password)", async () => {
    const resolver = createEncryptionKey();

    const key1 = await resolver.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver.resolve({ document: "doc-2", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).not.toBe(exported2.k);
  });

  it("should derive a consistent key for the same document and password", async () => {
    const resolver1 = createEncryptionKey("my-password");
    const resolver2 = createEncryptionKey("my-password");

    const key1 = await resolver1.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver2.resolve({ document: "doc-1", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).toBe(exported2.k);
  });

  it("should derive different keys for different passwords", async () => {
    const resolver1 = createEncryptionKey("password-a");
    const resolver2 = createEncryptionKey("password-b");

    const key1 = await resolver1.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver2.resolve({ document: "doc-1", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).not.toBe(exported2.k);
  });

  it("should derive different keys with and without password", async () => {
    const resolver1 = createEncryptionKey();
    const resolver2 = createEncryptionKey("password");

    const key1 = await resolver1.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver2.resolve({ document: "doc-1", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).not.toBe(exported2.k);
  });

  it("should cache the derived key for repeated resolves", async () => {
    const resolver = createEncryptionKey("my-password");

    const key1 = await resolver.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver.resolve({ document: "doc-1", connection: {} as any });

    expect(key1).toBe(key2);
  });

  it("should produce a usable AES-GCM key", async () => {
    const resolver = createEncryptionKey("my-password");
    const key = await resolver.resolve({ document: "doc-1", connection: {} as any });

    expect((key.algorithm as any).name).toBe("AES-GCM");
    expect((key.algorithm as any).length).toBe(256);

    const plaintext = new Uint8Array([10, 20, 30]);
    const encrypted = await encryptUpdate(key, plaintext);
    const decrypted = await decryptUpdate(key, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it("derives the SAME key as simpleEncryption() when no password is given", async () => {
    const { simpleEncryption } = await import("./key-resolver");
    const a = await createEncryptionKey().resolve({ document: "doc-x", connection: {} as any });
    const b = await simpleEncryption().resolve({ document: "doc-x", connection: {} as any });
    const [ea, eb] = await Promise.all([
      crypto.subtle.exportKey("jwk", a),
      crypto.subtle.exportKey("jwk", b),
    ]);
    expect(ea.k).toBe(eb.k);
  });

  it("derives the SAME key as passwordKey() when a password is given", async () => {
    const { passwordKey } = await import("./key-resolver");
    const a = await createEncryptionKey("pw").resolve({ document: "doc-x", connection: {} as any });
    const b = await passwordKey("pw").resolve({ document: "doc-x", connection: {} as any });
    const [ea, eb] = await Promise.all([
      crypto.subtle.exportKey("jwk", a),
      crypto.subtle.exportKey("jwk", b),
    ]);
    expect(ea.k).toBe(eb.k);
  });
});
