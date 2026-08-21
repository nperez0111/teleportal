import { createClientExtension, type RpcExtension, type RpcExtensionContext } from "teleportal/rpc";
import { boopProtocol } from "./boop-protocol";

export interface BoopRpc {
  send(targetAwarenessId: number): Promise<{ success: boolean }>;
  onBooped(callback: (fromAwarenessId: number) => void): () => void;
}

const notifyBooped = Symbol("boop.notifyBooped");

type BoopInstance = BoopRpc & { [notifyBooped]: (fromAwarenessId: number) => void };

const boopExtension = createClientExtension(boopProtocol, {
  build(methods, ctx): BoopRpc {
    const callbacks = new Set<(fromAwarenessId: number) => void>();
    const instance: BoopInstance = {
      async send(targetAwarenessId: number) {
        return methods.send({
          targetAwarenessId,
          fromAwarenessId: ctx.awareness.clientID,
        });
      },
      onBooped(callback) {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      [notifyBooped](fromAwarenessId: number) {
        for (const cb of callbacks) cb(fromAwarenessId);
      },
    };
    return instance;
  },
});

export const createBoopRpc = (): RpcExtension<BoopRpc> => {
  const base = boopExtension();
  let instance: BoopInstance | undefined;
  let myAwarenessId: number | undefined;
  let document: string | undefined;

  return {
    create(ctx: RpcExtensionContext) {
      document = ctx.document;
      myAwarenessId = ctx.awareness.clientID;
      instance = base.create(ctx) as BoopInstance;
      return instance;
    },

    handleMessage(message) {
      if (message.rpcMethod !== "booped") return false;
      if (message.document !== document) return false;
      const payload = message.payload?.payload as
        | { targetAwarenessId?: number; fromAwarenessId?: number }
        | undefined;
      if (payload?.targetAwarenessId !== myAwarenessId) return false;
      if (payload?.fromAwarenessId !== undefined) {
        instance?.[notifyBooped](payload.fromAwarenessId);
      }
      return true;
    },

    destroy() {
      base.destroy?.();
      instance = undefined;
      myAwarenessId = undefined;
      document = undefined;
    },
  };
};
