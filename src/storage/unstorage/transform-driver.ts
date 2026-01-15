import { defineDriver } from "unstorage";
import type { Driver, StorageMeta, StorageValue } from "unstorage";

export interface TransformDriverOptions {
  driver: Driver;
  onWrite: (
    key: string,
    value: StorageValue,
    type: "value" | "meta",
  ) => Promise<string>;
  onRead: (
    key: string,
    value: StorageValue,
    type: "value" | "meta",
  ) => Promise<StorageValue>;
}

const DRIVER_NAME = "transform";

export default defineDriver((options: TransformDriverOptions) => {
  return {
    name: DRIVER_NAME,
    options: options,
    async hasItem(key, opts) {
      if (await options.driver.hasItem(key, opts)) {
        return true;
      }
      return false;
    },
    async getItem(key, opts) {
      const value = await options.driver.getItem(key, opts);
      if (value === null) {
        return null;
      }
      return await options.onRead(
        key,
        value,
        key.endsWith("$") ? "meta" : "value",
      );
    },
    async setItemRaw(key, value, opts) {
      await options.driver.setItemRaw?.(
        key,
        await options.onWrite(key, value, key.endsWith("$") ? "meta" : "value"),
        opts,
      );
    },
    async getItemRaw(key, opts) {
      if (!options.driver.getItemRaw) {
        return undefined;
      }
      const value = await options.driver.getItemRaw(key, opts);
      if (value === null) {
        return null;
      }

      return await options.onRead(
        key,
        value as Uint8Array,
        key.endsWith("$") ? "meta" : "value",
      );
    },
    async getMeta(key, opts) {
      if (options.driver.getMeta) {
        const meta = await options.driver.getMeta(key, opts);
        if (meta === null) {
          return null;
        }
        return (await options.onRead(
          key,
          meta,
          "meta",
        )) as unknown as StorageMeta;
      }
      return null;
    },
    async setItem(key, value, opts) {
      await options.driver.setItem?.(
        key,
        await options.onWrite(key, value, key.endsWith("$") ? "meta" : "value"),
        opts,
      );
    },
    async removeItem(key, opts) {
      await options.driver.removeItem?.(key, opts);
    },
    async getKeys(base, opts) {
      return await options.driver.getKeys(base, opts);
    },
    async dispose() {
      await options.driver.dispose?.();
    },
  };
});
