import { describe, expect, it } from "bun:test";
import { logger, type Logger } from "./logger";

describe("Logger", () => {
  it("should export a logger instance", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("should export Logger type", () => {
    // This is a type test - if it compiles, it passes
    const testLogger: Logger = logger;
    expect(testLogger).toBeDefined();
  });

  it("should have child method", () => {
    expect(typeof logger.child).toBe("function");
    const childLogger = logger.child();
    expect(childLogger).toBeDefined();
    expect(childLogger).not.toBe(logger);
  });

  it("should have withContext method", () => {
    expect(typeof logger.withContext).toBe("function");
    const contextLogger = logger.withContext({ test: "value" });
    expect(contextLogger).toBeDefined();
  });

  it("should have withMetadata method", () => {
    expect(typeof logger.withMetadata).toBe("function");
    const metadataLogger = logger.withMetadata({ test: "value" });
    expect(metadataLogger).toBeDefined();
  });

  it("should have withError method", () => {
    expect(typeof logger.withError).toBe("function");
    const error = new Error("test error");
    const errorLogger = logger.withError(error);
    expect(errorLogger).toBeDefined();
  });
});
