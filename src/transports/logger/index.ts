import type { Transport } from "teleportal";
import { withPassthrough } from "../passthrough";

/**
 * A transport that wraps another transport and logs all updates to the console.
 *
 * @param transport - The transport to log.
 * @returns The logged transport.
 */
export function withLogger<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: Transport<Context, AdditionalProperties>,
): Transport<Context, AdditionalProperties> {
  return withPassthrough(transport, {
    onWrite: (chunk) => {
      console.info("transport write", chunk.toString(), chunk);
    },
    onRead: (chunk) => {
      console.info("transport read", chunk.toString(), chunk);
    },
  });
}
