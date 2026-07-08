import { createClientExtension, type RpcExtension } from "teleportal/rpc";
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
  /**
   * Register a callback invoked when the server broadcasts a `keysRotated`
   * notification for THIS document. Returns an unsubscribe function.
   */
  onKeysRotated(callback: (generation: number) => void): () => void;
}

/** Symbol-keyed internal method so it can't collide with the public API. */
const notifyRotated = Symbol("keyRegistry.notifyRotated");

type KeyRegistryInstance = KeyRegistryRpc & { [notifyRotated]: (generation: number) => void };

const keyRegistryExtension = createClientExtension(keyRegistryProtocol, {
  build(methods): KeyRegistryRpc {
    const rotationCallbacks = new Set<(generation: number) => void>();
    const instance: KeyRegistryInstance = {
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
        return () => rotationCallbacks.delete(callback);
      },
      // Internal hook used by the per-provider factory below to fan a routed
      // notification out to this instance's callbacks. Not part of the public
      // KeyRegistryRpc surface.
      [notifyRotated](generation: number) {
        for (const cb of rotationCallbacks) cb(generation);
      },
    };
    return instance;
  },
});

/**
 * Per-provider key-registry extension factory.
 *
 * Each Provider (i.e. each document) gets its own extension instance with its
 * own rotation-callback set, captured in `create()`. A shared connection can
 * carry `keysRotated` notifications belonging to several documents, so
 * `handleMessage` only dispatches to the instance whose document matches the
 * message. Destroying one provider clears only its own callbacks and never
 * disables notifications for the others.
 */
export const createKeyRegistryRpc = (): RpcExtension<KeyRegistryRpc> => {
  const base = keyRegistryExtension();
  let instance: KeyRegistryInstance | undefined;
  let document: string | undefined;

  return {
    create(ctx) {
      document = ctx.document;
      instance = base.create(ctx) as KeyRegistryInstance;
      return instance;
    },

    handleMessage(message) {
      if (message.rpcMethod !== "keysRotated") return false;
      // Only dispatch notifications addressed to this instance's document; a
      // shared connection can carry rotations belonging to other documents.
      if (message.document !== document) return false;
      const payload = message.payload?.payload as { generation?: number } | undefined;
      const generation = payload?.generation;
      if (generation === undefined) return true;
      instance?.[notifyRotated](generation);
      return true;
    },

    destroy() {
      base.destroy?.();
      instance = undefined;
      document = undefined;
    },
  };
};
