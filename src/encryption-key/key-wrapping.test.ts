import { describe, expect, it } from "bun:test";
import { createEncryptionKey, encryptUpdate, decryptUpdate } from "./index";
import {
  deriveWrappingKey,
  wrapDocumentKey,
  unwrapDocumentKey,
  exportWrappingKey,
  importWrappingKey,
} from "./key-wrapping";

const MASTER_SECRET = crypto.getRandomValues(new Uint8Array(32));

describe("Key Wrapping", () => {
  describe("deriveWrappingKey", () => {
    it("should derive a deterministic wrapping key from masterSecret + userId", async () => {
      const key1 = await deriveWrappingKey(MASTER_SECRET, "alice");
      const key2 = await deriveWrappingKey(MASTER_SECRET, "alice");

      const exported1 = await exportWrappingKey(key1);
      const exported2 = await exportWrappingKey(key2);
      expect(exported1).toBe(exported2);
    });

    it("should derive different keys for different userIds (domain separation)", async () => {
      const keyAlice = await deriveWrappingKey(MASTER_SECRET, "alice");
      const keyBob = await deriveWrappingKey(MASTER_SECRET, "bob");

      const exportedAlice = await exportWrappingKey(keyAlice);
      const exportedBob = await exportWrappingKey(keyBob);
      expect(exportedAlice).not.toBe(exportedBob);
    });

    it("should derive different keys for different master secrets", async () => {
      const otherSecret = crypto.getRandomValues(new Uint8Array(32));
      const key1 = await deriveWrappingKey(MASTER_SECRET, "alice");
      const key2 = await deriveWrappingKey(otherSecret, "alice");

      const exported1 = await exportWrappingKey(key1);
      const exported2 = await exportWrappingKey(key2);
      expect(exported1).not.toBe(exported2);
    });

    it("should produce an AES-KW key with wrapKey/unwrapKey usages", async () => {
      const key = await deriveWrappingKey(MASTER_SECRET, "alice");
      expect((key.algorithm as any).name).toBe("AES-KW");
      expect((key.algorithm as any).length).toBe(256);
      expect(key.usages).toContain("wrapKey");
      expect(key.usages).toContain("unwrapKey");
    });
  });

  describe("wrapDocumentKey / unwrapDocumentKey", () => {
    it("should round-trip a document key through wrap → unwrap", async () => {
      const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
      const documentKey = await createEncryptionKey();

      const wrapped = await wrapDocumentKey(wrappingKey, documentKey);
      const unwrapped = await unwrapDocumentKey(wrappingKey, wrapped);

      const originalExported = await crypto.subtle.exportKey("jwk", documentKey);
      const unwrappedExported = await crypto.subtle.exportKey("jwk", unwrapped);
      expect(unwrappedExported.k).toBe(originalExported.k);
    });

    it("should produce an opaque blob different from the raw key", async () => {
      const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
      const documentKey = await createEncryptionKey();

      const wrapped = await wrapDocumentKey(wrappingKey, documentKey);
      const rawKey = await crypto.subtle.exportKey("raw", documentKey);

      expect(wrapped.byteLength).toBeGreaterThan(0);
      expect(wrapped).not.toEqual(new Uint8Array(rawKey));
    });

    it("should fail to unwrap with a different wrapping key", async () => {
      const wrappingKeyAlice = await deriveWrappingKey(MASTER_SECRET, "alice");
      const wrappingKeyBob = await deriveWrappingKey(MASTER_SECRET, "bob");
      const documentKey = await createEncryptionKey();

      const wrapped = await wrapDocumentKey(wrappingKeyAlice, documentKey);

      await expect(unwrapDocumentKey(wrappingKeyBob, wrapped)).rejects.toThrow();
    });

    it("should produce an unwrapped key that works for encrypt/decrypt", async () => {
      const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
      const documentKey = await createEncryptionKey();

      const wrapped = await wrapDocumentKey(wrappingKey, documentKey);
      const unwrapped = await unwrapDocumentKey(wrappingKey, wrapped);

      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
      const encrypted = await encryptUpdate(unwrapped, plaintext);
      const decrypted = await decryptUpdate(unwrapped, encrypted);
      expect(decrypted).toEqual(plaintext);
    });
  });

  describe("exportWrappingKey / importWrappingKey", () => {
    it("should round-trip a wrapping key through export → import", async () => {
      const original = await deriveWrappingKey(MASTER_SECRET, "alice");
      const exported = await exportWrappingKey(original);
      const imported = await importWrappingKey(exported);

      const reExported = await exportWrappingKey(imported);
      expect(reExported).toBe(exported);
    });

    it("should produce a string suitable for JWT claims", async () => {
      const key = await deriveWrappingKey(MASTER_SECRET, "alice");
      const exported = await exportWrappingKey(key);

      expect(typeof exported).toBe("string");
      expect(exported.length).toBeGreaterThan(0);
    });

    it("should import a key that can unwrap document keys", async () => {
      const original = await deriveWrappingKey(MASTER_SECRET, "alice");
      const exported = await exportWrappingKey(original);
      const imported = await importWrappingKey(exported);

      const documentKey = await createEncryptionKey();
      const wrapped = await wrapDocumentKey(original, documentKey);
      const unwrapped = await unwrapDocumentKey(imported, wrapped);

      const docExported = await crypto.subtle.exportKey("jwk", documentKey);
      const unwrappedExported = await crypto.subtle.exportKey("jwk", unwrapped);
      expect(unwrappedExported.k).toBe(docExported.k);
    });
  });
});
