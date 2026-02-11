import { fromBase64, toBase64 } from "lib0/buffer";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { decryptUpdate, encryptUpdate } from "teleportal/encryption-key";
import type { Driver } from "unstorage";
import TransformDriver from "./transform-driver";

export function createEncryptedDriver(
  driver: Driver,
  getKey:
    | CryptoKey
    | Promise<CryptoKey>
    | ((key: string) => CryptoKey | Promise<CryptoKey>),
) {
  return TransformDriver({
    driver,
    onWrite: async (key, value) => {
      return toBase64(
        await encryptUpdate(
          typeof getKey === "function" ? await getKey(key) : await getKey,
          encoding.encode((encoder) => {
            encoding.writeAny(encoder, value as encoding.AnyEncodable);
          }),
        ),
      );
    },
    onRead: async (key, value) => {
      if (typeof value !== "string") {
        throw new TypeError("Value not encrypted", { cause: { key, value } });
      }

      const decoder = decoding.createDecoder(
        await decryptUpdate(
          typeof getKey === "function" ? await getKey(key) : await getKey,
          fromBase64(value),
        ),
      );
      return decoding.readAny(decoder);
    },
  });
}
