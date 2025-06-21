import { describe, expect, it } from "bun:test";
import {
  createEncryptionKey,
  importEncryptionKey,
  exportEncryptionKey,
  encryptUpdate,
  decryptUpdate,
} from "./index";
import type { Update } from "match-maker";

// Helper function to create a proper Update type
function createUpdate(data: Uint8Array): Update {
  return data as Update;
}

describe("Encryption Functions", () => {
  it("should encrypt and decrypt an update successfully", async () => {
    const key = await createEncryptionKey();
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
    const key = await createEncryptionKey();
    const emptyUpdate = createUpdate(new Uint8Array(0));

    const encrypted = await encryptUpdate(key, emptyUpdate);
    const decrypted = await decryptUpdate(key, encrypted);

    expect(decrypted).toEqual(emptyUpdate);
  });

  it("should handle large updates", async () => {
    const key = await createEncryptionKey();
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
    const key = await createEncryptionKey();
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
    const key = await createEncryptionKey();
    const updates = [
      createUpdate(new Uint8Array([1, 2, 3])),
      createUpdate(new Uint8Array([4, 5, 6])),
      createUpdate(new Uint8Array([7, 8, 9])),
    ];

    const encrypted = await Promise.all(
      updates.map((update) => encryptUpdate(key, update)),
    );

    const decrypted = await Promise.all(
      encrypted.map((enc) => decryptUpdate(key, enc)),
    );

    expect(decrypted).toEqual(updates);
  });

  it("should generate different encrypted outputs for the same input", async () => {
    const key = await createEncryptionKey();
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

  it("should handle multiple keys independently", async () => {
    const key1 = await createEncryptionKey();
    const key2 = await createEncryptionKey();
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
    const key1 = await createEncryptionKey();
    const key2 = await createEncryptionKey();

    const exported1 = await exportEncryptionKey(key1);
    const exported2 = await exportEncryptionKey(key2);

    // Keys should be different
    expect(exported1).not.toEqual(exported2);
  });

  it("should work with imported keys from different sources", async () => {
    // Create two different keys
    const key1 = await createEncryptionKey();
    const key2 = await createEncryptionKey();

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
