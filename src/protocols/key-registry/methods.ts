import { defineMethod, defineProtocol } from "teleportal/rpc";

export const keysGet = defineMethod<
  "keysGet",
  Record<string, never>,
  { wrappedKey: Uint8Array; generation: number }
>("keysGet");

export const keysSet = defineMethod<
  "keysSet",
  { entries: { userId: string; wrappedKey: Uint8Array }[] },
  { generation: number }
>("keysSet");

export const keysRevoke = defineMethod<"keysRevoke", { userIds: string[] }, { generation: number }>(
  "keysRevoke",
);

export const keysMeta = defineMethod<
  "keysMeta",
  Record<string, never>,
  { generation: number; userIds: string[] }
>("keysMeta");

export const keysRotate = defineMethod<
  "keysRotate",
  {
    entries: { userId: string; wrappedKey: Uint8Array }[];
    expectedGeneration: number;
  },
  { generation: number }
>("keysRotate");

export const keyRegistryProtocol = defineProtocol("key-registry", {
  get: keysGet,
  set: keysSet,
  revoke: keysRevoke,
  meta: keysMeta,
  rotate: keysRotate,
});
