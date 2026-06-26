import type { Connection } from "teleportal/providers";

const encoder = new TextEncoder();

export type KeyResolverContext = {
  document: string;
  connection: Connection;
};

/**
 * A `KeyResolver` asynchronously resolves an encryption key for a document.
 *
 * Pass as the `encryptionKey` option to `Provider.create` — the key will be
 * resolved after the connection is ready but before the Provider is constructed.
 */
export type KeyResolver = {
  resolve(ctx: KeyResolverContext): Promise<CryptoKey>;
  onInvalidate?(callback: (document: string) => void): void;
};

/**
 * Derive a per-document encryption key from a shared passphrase via PBKDF2.
 *
 * All users with the same passphrase derive the same key independently —
 * no server involvement, no key registry. Good for "share a link with a
 * password" use cases. The trade-off: no per-user revocation.
 */
export function passwordKey(passphrase: string): KeyResolver {
  const cache = new Map<string, CryptoKey>();
  return {
    async resolve({ document }) {
      let key = cache.get(document);
      if (!key) {
        const keyMaterial = await crypto.subtle.importKey(
          "raw",
          encoder.encode(passphrase),
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
        cache.set(document, key);
      }
      return key;
    },
  };
}
