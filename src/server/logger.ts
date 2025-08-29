import { ConsoleTransport, LogLayer, type ILogLayer } from "loglayer";

// Export the default logger instance
export const logger = new LogLayer({
  transport: new ConsoleTransport({
    logger: console,
    level: "info",
  }),
  errorSerializer: (err) => ({
    message: err.message,
    stack: err.stack,
    code: err.code,
    cause: err.cause,
  }),
});

// Export the LogLayer type for use in other modules
export type Logger = ILogLayer;
