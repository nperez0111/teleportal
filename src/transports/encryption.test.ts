import { describe, expect, it, beforeEach } from "bun:test";
import { UpdateEncryptionManager } from "./encryption";
import type { Update } from "../lib";

// Helper function to create a proper Update type
function createUpdate(data: Uint8Array): Update {
  return data as Update;
}

describe("UpdateEncryptionManager", () => {
  beforeEach(() => {
    // Reset the encryption manager before each test
    UpdateEncryptionManager.reset();
  });

  it("should encrypt and decrypt an update successfully", async () => {
    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

    // Encrypt the update
    const encrypted = await UpdateEncryptionManager.encryptUpdate(testUpdate);

    // Verify the encrypted data is different from the original
    expect(encrypted).not.toEqual(testUpdate);
    expect(encrypted.length).toBeGreaterThan(testUpdate.length);

    // Decrypt the update
    const decrypted = await UpdateEncryptionManager.decryptUpdate(encrypted);

    // Verify the decrypted data matches the original
    expect(decrypted).toEqual(testUpdate);
  });

  it("should handle empty updates", async () => {
    const emptyUpdate = createUpdate(new Uint8Array(0));

    const encrypted = await UpdateEncryptionManager.encryptUpdate(emptyUpdate);
    const decrypted = await UpdateEncryptionManager.decryptUpdate(encrypted);

    expect(decrypted).toEqual(emptyUpdate);
  });

  it("should handle large updates", async () => {
    const largeUpdate = new Uint8Array(1000);
    for (let i = 0; i < largeUpdate.length; i++) {
      largeUpdate[i] = i % 256;
    }

    const encrypted = await UpdateEncryptionManager.encryptUpdate(
      createUpdate(largeUpdate),
    );
    const decrypted = await UpdateEncryptionManager.decryptUpdate(encrypted);

    expect(decrypted).toEqual(createUpdate(largeUpdate));
  });

  it("should export and import keys correctly", async () => {
    // First, encrypt something to generate a key
    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));
    await UpdateEncryptionManager.encryptUpdate(testUpdate);

    // Export the key
    const exportedKey = await UpdateEncryptionManager.exportEncryptionKey();
    expect(exportedKey).toBeDefined();
    expect(typeof exportedKey).toBe("string");

    // Reset the manager
    UpdateEncryptionManager.reset();

    // Import the key
    await UpdateEncryptionManager.setEncryptionKey(exportedKey!);

    // Test that encryption/decryption still works
    const encrypted = await UpdateEncryptionManager.encryptUpdate(testUpdate);
    const decrypted = await UpdateEncryptionManager.decryptUpdate(encrypted);

    expect(decrypted).toEqual(testUpdate);
  });

  it("should handle multiple consecutive operations", async () => {
    const updates = [
      createUpdate(new Uint8Array([1, 2, 3])),
      createUpdate(new Uint8Array([4, 5, 6])),
      createUpdate(new Uint8Array([7, 8, 9])),
    ];

    const encrypted = await Promise.all(
      updates.map((update) => UpdateEncryptionManager.encryptUpdate(update)),
    );

    const decrypted = await Promise.all(
      encrypted.map((enc) => UpdateEncryptionManager.decryptUpdate(enc)),
    );

    expect(decrypted).toEqual(updates);
  });

  it("should generate different encrypted outputs for the same input", async () => {
    const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));

    const encrypted1 = await UpdateEncryptionManager.encryptUpdate(testUpdate);
    const encrypted2 = await UpdateEncryptionManager.encryptUpdate(testUpdate);

    // The encrypted outputs should be different due to random IV
    expect(encrypted1).not.toEqual(encrypted2);

    // But both should decrypt to the same original data
    const decrypted1 = await UpdateEncryptionManager.decryptUpdate(encrypted1);
    const decrypted2 = await UpdateEncryptionManager.decryptUpdate(encrypted2);

    expect(decrypted1).toEqual(testUpdate);
    expect(decrypted2).toEqual(testUpdate);
  });
});
