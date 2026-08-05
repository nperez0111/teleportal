import { defineMethod, definePush, defineProtocol } from "teleportal/rpc";

export const keysGet = defineMethod<
  Record<string, never>,
  { wrappedKey: Uint8Array; generation: number }
>();

export const keysSet = defineMethod<
  { entries: { userId: string; wrappedKey: Uint8Array }[] },
  { generation: number }
>();

export const keysRevoke = defineMethod<{ userIds: string[] }, { generation: number }>();

export const keysMeta = defineMethod<
  Record<string, never>,
  { generation: number; userIds: string[] }
>();

export const keysRotate = defineMethod<
  {
    entries: { userId: string; wrappedKey: Uint8Array }[];
    expectedGeneration: number;
  },
  { generation: number }
>();

/**
 * Tells key holders the document key was rotated, so they re-fetch it.
 *
 * Not replicated: the new generation is already in the shared key registry, so each node
 * notifies its own clients rather than fanning this across the cluster.
 */
export const keysRotated = definePush<{ generation: number }>({ qos: { replicate: false } });

export const keyRegistryProtocol = defineProtocol("key-registry", {
  get: keysGet,
  set: keysSet,
  revoke: keysRevoke,
  meta: keysMeta,
  rotate: keysRotate,
  rotated: keysRotated,
});
