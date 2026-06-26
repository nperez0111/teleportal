import { describe, expect, it } from "bun:test";
import { encryptUpdate, decryptUpdate } from "./index";
import { passwordKey } from "./key-resolver";

describe("passwordKey", () => {
  it("should derive a consistent key for the same passphrase + document", async () => {
    const resolver1 = passwordKey("my-secret");
    const resolver2 = passwordKey("my-secret");

    const key1 = await resolver1.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver2.resolve({ document: "doc-1", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).toBe(exported2.k);
  });

  it("should derive different keys for different documents", async () => {
    const resolver = passwordKey("my-secret");

    const key1 = await resolver.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver.resolve({ document: "doc-2", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).not.toBe(exported2.k);
  });

  it("should derive different keys for different passphrases", async () => {
    const resolver1 = passwordKey("password-a");
    const resolver2 = passwordKey("password-b");

    const key1 = await resolver1.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver2.resolve({ document: "doc-1", connection: {} as any });

    const exported1 = await crypto.subtle.exportKey("jwk", key1);
    const exported2 = await crypto.subtle.exportKey("jwk", key2);
    expect(exported1.k).not.toBe(exported2.k);
  });

  it("should cache the derived key for repeated resolves", async () => {
    const resolver = passwordKey("my-secret");

    const key1 = await resolver.resolve({ document: "doc-1", connection: {} as any });
    const key2 = await resolver.resolve({ document: "doc-1", connection: {} as any });

    expect(key1).toBe(key2);
  });

  it("should produce a usable AES-GCM key", async () => {
    const resolver = passwordKey("my-secret");
    const key = await resolver.resolve({ document: "doc-1", connection: {} as any });

    expect(key.algorithm).toEqual({ name: "AES-GCM", length: 256 });

    const plaintext = new Uint8Array([10, 20, 30]);
    const encrypted = await encryptUpdate(key, plaintext);
    const decrypted = await decryptUpdate(key, encrypted);
    expect(decrypted).toEqual(plaintext);
  });
});
