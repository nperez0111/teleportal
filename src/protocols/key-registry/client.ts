import { createClientExtension } from "teleportal/rpc";
import { keyRegistryProtocol } from "./methods";

export interface KeyRegistryRpc {
  get(): Promise<{ wrappedKey: Uint8Array; generation: number }>;
  set(entries: { userId: string; wrappedKey: Uint8Array }[]): Promise<{ generation: number }>;
  revoke(userIds: string[]): Promise<{ generation: number }>;
  meta(): Promise<{ generation: number; userIds: string[] }>;
  rotate(
    entries: { userId: string; wrappedKey: Uint8Array }[],
    expectedGeneration: number,
  ): Promise<{ generation: number }>;
  onKeysRotated(callback: (generation: number) => void): void;
}

export const createKeyRegistryRpc = createClientExtension(keyRegistryProtocol, {
  handleMessage(message: any): boolean {
    if (message.rpcMethod === "keysRotated") {
      const generation = message.payload?.payload?.generation;
      rotationCallbacks.forEach((cb) => cb(generation));
      return true;
    }
    return false;
  },

  build(methods, _ctx): KeyRegistryRpc {
    return {
      async get() {
        return methods.get({});
      },
      async set(entries) {
        return methods.set({ entries });
      },
      async revoke(userIds) {
        return methods.revoke({ userIds });
      },
      async meta() {
        return methods.meta({});
      },
      async rotate(entries, expectedGeneration) {
        return methods.rotate({ entries, expectedGeneration });
      },
      onKeysRotated(callback) {
        rotationCallbacks.add(callback);
      },
    };
  },

  destroy() {
    rotationCallbacks.clear();
  },
});

const rotationCallbacks = new Set<(generation: number) => void>();
