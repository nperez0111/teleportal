import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { AckMessage, RpcMessage } from "teleportal/protocol";
import type { RpcClient } from "./rpc-client";
/**
 * Context provided to RPC extensions during initialization.
 * This is the boundary — extensions don't get the full Provider.
 *
 * Uses a structural type for connection to avoid coupling to a specific
 * Connection class (old abstract vs new concrete).
 */
export interface RpcExtensionContext {
  readonly rpcClient: RpcClient;
  readonly document: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly encryptionKey?: CryptoKey;
  readonly connection: {
    readonly state: { type: string };
    send(message: any): Promise<void>;
    readonly connected: Promise<void>;
    on(event: string, callback: (...args: any[]) => void): () => void;
  };
  readonly synced: Promise<void>;
}

/**
 * An RPC extension that adds methods to the provider.rpc namespace.
 * T is the public API object returned by create().
 */
export interface RpcExtension<T> {
  create(ctx: RpcExtensionContext): T;
  destroy?(): void;
  handleMessage?(message: RpcMessage<any>): boolean | Promise<boolean>;
  handleAck?(message: AckMessage<any>): boolean | Promise<boolean>;
}

/**
 * Map of extension name → factory function that creates the extension.
 */
export type RpcExtensionMap = Record<string, () => RpcExtension<any>>;

/**
 * Derives the typed .rpc namespace from an RpcExtensionMap.
 * Each key maps to the return type of the extension's create() method.
 */
export type RpcNamespace<M extends RpcExtensionMap> = {
  [K in keyof M]: ReturnType<ReturnType<M[K]>["create"]>;
};
