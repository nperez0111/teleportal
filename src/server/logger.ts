import { getLogger as getBaseLogger } from "@logtape/logtape";

/**
 * Environment context added to every wide event for deployment correlation.
 * Captured once at module load so it can be merged into all wide events.
 */
export const envContext: Record<string, unknown> = {
  service: "teleportal",
};

/**
 * Single logger instance for the Teleportal server.
 * Use this logger everywhere; add context via .with({ ... }).
 * Per LogTape's library guidelines we avoid configuring sinks here.
 */
export const logger = getBaseLogger(["teleportal", "server"]);

export type WideEvent = Record<string, unknown>;

/**
 * Emit a single wide event (canonical log line) with env context merged in.
 * Use for one event per logical operation (e.g. per message, per request, per connection).
 * Level is either "info" (normal operations) or "error" (failures that need attention).
 */
export function emitWideEvent(level: "info" | "error", event: WideEvent): void {
  const payload = { ...envContext, ...event };
  if (level === "error") {
    logger.error(payload);
  } else {
    logger.info(payload);
  }
}
