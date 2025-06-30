import { ConsoleTransport, LogLayer, type ILogLayer } from "loglayer";

// Create the default logger instance
let loggerInstance: LogLayer = new LogLayer({
  transport: new ConsoleTransport({
    logger: console,
  }),
});

// Export the logger instance
export const logger = loggerInstance;

// Export the LogLayer type for use in other modules
export type Logger = ILogLayer;

// Function to replace the logger transport
export function setLoggerTransport(newTransport: any) {
  loggerInstance = new LogLayer({
    transport: newTransport,
  });
}

// Function to get the current logger instance
export function getLogger(): LogLayer {
  return loggerInstance;
}

// Function to create a child logger with context
export function createChildLogger(context: Record<string, any>): LogLayer {
  return loggerInstance.withContext(context);
}
