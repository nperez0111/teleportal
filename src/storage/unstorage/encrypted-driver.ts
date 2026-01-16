import { fromBase64, toBase64 } from "lib0/buffer";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { decryptUpdate, encryptUpdate } from "teleportal/encryption-key";
import type { Driver } from "unstorage";
import TransformDriver from "./transform-driver";

export function createEncryptedDriver(
  driver: Driver,
  getKey: (key: string) => CryptoKey,
) {
  return TransformDriver({
    driver,
    onWrite: async (key, value) => {
      return toBase64(
        await encryptUpdate(
          getKey(key),
          encoding.encode((encoder) => {
            encoding.writeAny(encoder, value);
          }),
        ),
      );
    },
    onRead: async (key, value) => {
      if (typeof value !== "string") {
        throw new Error("Value not encrypted", { cause: { key, value } });
      }

      const decoder = decoding.createDecoder(
        await decryptUpdate(getKey(key), fromBase64(value)),
      );
      return decoding.readAny(decoder);
    },
  });
}
