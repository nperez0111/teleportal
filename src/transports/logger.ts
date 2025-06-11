import type { YTransport } from "../base";
import { passthrough } from "./passthrough";

/**
 * A transport that wraps another transport and logs all updates to the console.
 *
 * @param transport - The transport to log.
 * @returns The logged transport.
 */
export function logger<
  Context extends Record<string, unknown>,
  InstanceOptions extends Record<string, unknown>,
>(
  transport: YTransport<Context, InstanceOptions>,
): YTransport<Context, InstanceOptions> {
  return passthrough(transport, {
    onWrite: (chunk) => {
      console.log({
        on: "write",
        chunk,
      });
    },
    onRead: (chunk) => {
      console.log({
        on: "read",
        chunk,
      });
    },
  });
}
