import { defineMethod, defineProtocol } from "teleportal/rpc";

export const boopSend = defineMethod<
  "boopSend",
  { targetAwarenessId: number; fromAwarenessId: number },
  { success: boolean }
>("boopSend");

export const boopProtocol = defineProtocol("boop", {
  send: boopSend,
});
