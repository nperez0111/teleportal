import type { YTransport } from "../base";
import { withPassthrough } from "./passthrough";
import pino from "pino";

const logger = pino({
  name: "logger",
});

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
  transport: YTransport<Context, AdditionalProperties>,
): YTransport<Context, AdditionalProperties> {
  return withPassthrough(transport, {
    onWrite: (chunk) => {
      logger.info(
        {
          type: "write",
          chunk,
        },
        "transport write",
      );
    },
    onRead: (chunk) => {
      logger.info(
        {
          type: "read",
          chunk,
        },
        "transport read",
      );
    },
  });
}
