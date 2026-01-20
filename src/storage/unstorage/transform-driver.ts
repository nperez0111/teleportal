import type { Driver, StorageValue } from "unstorage";
import { defineDriver } from "unstorage";

export interface TransformDriverOptions {
  driver: Driver;
  onWrite: (key: string, value: StorageValue) => Promise<string>;
  onRead: (key: string, value: StorageValue) => Promise<StorageValue>;
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
      if (key.endsWith("$")) {
        return value;
      }
      return await options.onRead(key, value);
    },
    async setItemRaw(key, value, opts) {
      if (key.endsWith("$")) {
        return await options.driver.setItemRaw?.(key, value, opts);
      }
      await options.driver.setItemRaw?.(
        key,
        await options.onWrite(key, value),
        opts,
      );
    },
    async getItemRaw(key, opts) {
      const value = await options.driver.getItemRaw?.(key, opts);
      if (value === null || value === undefined) {
        return null;
      }
      if (key.endsWith("$")) {
        return value;
      }

      return await options.onRead(key, value as Uint8Array);
    },
    async getMeta(key, opts) {
      if (options.driver.getMeta) {
        return await options.driver.getMeta(key, opts);
      }
      return null;
    },
    async setItem(key, value, opts) {
      if (key.endsWith("$")) {
        return await options.driver.setItem?.(key, value, opts);
      }
      await options.driver.setItem?.(
        key,
        await options.onWrite(key, value),
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
