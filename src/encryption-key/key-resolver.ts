import type { Connection } from "teleportal/providers";
import { RpcClient } from "../providers/rpc-client";
import { unwrapDocumentKey } from "./key-wrapping";

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
/**
 * Resolve the document encryption key from the server's key registry.
 *
 * On connect, sends a `keysGet` RPC to fetch the wrapped key blob, then
 * unwraps it locally using the provided wrapping key. The wrapping key is
 * typically derived by the app server via `deriveWrappingKey()` and embedded
 * in the user's JWT token.
 *
 * Handles key rotation notifications: when the server broadcasts
 * `keysRotated`, the cached key is invalidated and re-fetched on the next
 * operation.
 */
export function registryKey(opts: {
  wrappingKey: CryptoKey | (() => Promise<CryptoKey>);
}): KeyResolver {
  let cachedKey: CryptoKey | undefined;
  let invalidateCallback: ((document: string) => void) | undefined;

  return {
    async resolve({ document, connection }) {
      if (cachedKey) return cachedKey;

      const rpc = new RpcClient(connection);
      try {
        const response = await rpc.sendRequest<{
          wrappedKey: Uint8Array;
          generation: number;
        }>(document, "keysGet", {});

        const wk =
          typeof opts.wrappingKey === "function"
            ? await opts.wrappingKey()
            : opts.wrappingKey;

        const wrappedKey =
          response.wrappedKey instanceof Uint8Array
            ? response.wrappedKey
            : new Uint8Array(response.wrappedKey as any);

        cachedKey = await unwrapDocumentKey(wk, wrappedKey);
        return cachedKey;
      } finally {
        rpc.destroy();
      }
    },

    onInvalidate(callback) {
      invalidateCallback = callback;
    },

    /** @internal Called by the key-registry RPC extension on rotation */
    _invalidate(document: string) {
      cachedKey = undefined;
      invalidateCallback?.(document);
    },
  } as KeyResolver & { _invalidate(document: string): void };
}

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
