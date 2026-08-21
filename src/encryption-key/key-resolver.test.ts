import { beforeAll, describe, expect, it } from "bun:test";
import { encryptUpdate, decryptUpdate } from "./index";
import { passwordKey, simpleEncryption } from "./key-resolver";

const CONN = { connection: {} as any };

describe("passwordKey", () => {
  // PBKDF2 at 600k iterations is ~65ms of CPU per derivation. Bun runs
  // `crypto.subtle.deriveKey` off the main thread, so deriving every key this
  // block needs concurrently up front costs about as much as one derivation.
  const mySecret = passwordKey("my-secret");
  const mySecretAgain = passwordKey("my-secret");
  const passwordA = passwordKey("password-a");
  const passwordB = passwordKey("password-b");

  /** JWK `k` values, keyed by the resolver that produced them. */
  const k: Record<string, string> = {};

  beforeAll(async () => {
    const entries = await Promise.all(
      (
        [
          ["mySecret/doc-1", mySecret.resolve({ document: "doc-1", ...CONN })],
          ["mySecretAgain/doc-1", mySecretAgain.resolve({ document: "doc-1", ...CONN })],
          ["mySecret/doc-2", mySecret.resolve({ document: "doc-2", ...CONN })],
          ["passwordA/doc-1", passwordA.resolve({ document: "doc-1", ...CONN })],
          ["passwordB/doc-1", passwordB.resolve({ document: "doc-1", ...CONN })],
        ] as const
      ).map(async ([name, keyPromise]) => {
        const exported = await crypto.subtle.exportKey("jwk", await keyPromise);
        return [name, exported.k!] as const;
      }),
    );
    for (const [name, value] of entries) k[name] = value;
  });

  it("should derive a consistent key for the same passphrase + document", () => {
    expect(k["mySecret/doc-1"]).toBe(k["mySecretAgain/doc-1"]!);
  });

  it("should derive different keys for different documents", () => {
    expect(k["mySecret/doc-1"]).not.toBe(k["mySecret/doc-2"]!);
  });

  it("should derive different keys for different passphrases", () => {
    expect(k["passwordA/doc-1"]).not.toBe(k["passwordB/doc-1"]!);
  });

  it("should cache the derived key for repeated resolves", async () => {
    const key1 = await mySecret.resolve({ document: "doc-1", ...CONN });
    const key2 = await mySecret.resolve({ document: "doc-1", ...CONN });

    expect(key1).toBe(key2);
  });

  it("should produce a usable AES-GCM key", async () => {
    const key = await mySecret.resolve({ document: "doc-1", ...CONN });

    expect((key.algorithm as any).name).toBe("AES-GCM");
    expect((key.algorithm as any).length).toBe(256);

    const plaintext = new Uint8Array([10, 20, 30]);
    const encrypted = await encryptUpdate(key, plaintext);
    const decrypted = await decryptUpdate(key, encrypted);
    expect(decrypted).toEqual(plaintext);
  });
});

describe("simpleEncryption", () => {
  const resolver = simpleEncryption();
  const resolverAgain = simpleEncryption();

  const k: Record<string, string> = {};

  beforeAll(async () => {
    const entries = await Promise.all(
      (
        [
          ["resolver/doc-1", resolver.resolve({ document: "doc-1", ...CONN })],
          ["resolverAgain/doc-1", resolverAgain.resolve({ document: "doc-1", ...CONN })],
          ["resolver/doc-2", resolver.resolve({ document: "doc-2", ...CONN })],
        ] as const
      ).map(async ([name, keyPromise]) => {
        const exported = await crypto.subtle.exportKey("jwk", await keyPromise);
        return [name, exported.k!] as const;
      }),
    );
    for (const [name, value] of entries) k[name] = value;
  });

  it("should derive a consistent key for the same document", () => {
    expect(k["resolver/doc-1"]).toBe(k["resolverAgain/doc-1"]!);
  });

  it("should derive different keys for different documents", () => {
    expect(k["resolver/doc-1"]).not.toBe(k["resolver/doc-2"]!);
  });

  it("should cache the derived key for repeated resolves", async () => {
    const key1 = await resolver.resolve({ document: "doc-1", ...CONN });
    const key2 = await resolver.resolve({ document: "doc-1", ...CONN });

    expect(key1).toBe(key2);
  });

  it("should produce a usable AES-GCM key", async () => {
    const key = await resolver.resolve({ document: "doc-1", ...CONN });

    expect((key.algorithm as any).name).toBe("AES-GCM");
    expect((key.algorithm as any).length).toBe(256);

    const plaintext = new Uint8Array([10, 20, 30]);
    const encrypted = await encryptUpdate(key, plaintext);
    const decrypted = await decryptUpdate(key, encrypted);
    expect(decrypted).toEqual(plaintext);
  });
});
