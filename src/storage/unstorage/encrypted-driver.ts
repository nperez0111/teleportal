import { fromBase64, toBase64 } from "lib0/buffer";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { decryptUpdate, encryptUpdate } from "teleportal/encryption-key";
import { Driver } from "unstorage";
import TransformDriver from "./transform-driver";

export function createEncryptedDriver(
  driver: Driver,
  getKey: (key: string) => CryptoKey,
) {
  return TransformDriver({
    driver,
    onWrite: async (key, value, type) => {
      if (type === "meta") {
        return value as string;
      }
      return toBase64(
        await encryptUpdate(
          getKey(key),
          encoding.encode((encoder) => {
            encoding.writeAny(encoder, value);
          }),
        ),
      );
    },
    onRead: async (key, value, type) => {
      if (type === "meta") {
        return value;
      }
      if (typeof value !== "string") {
        console.error("Invalid value", value, "key", key, "type", type);
        throw new Error("Invalid value");
      }
      const decoder = decoding.createDecoder(
        await decryptUpdate(getKey(key), fromBase64(value)),
      );
      return decoding.readAny(decoder);
    },
  });
}
