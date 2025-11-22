import { getPinoSink } from "@logtape/adaptor-pino";
import {
  configure,
  getConsoleSink,
  getLogger,
  type Sink,
} from "@logtape/logtape";
import { augmentLogger } from "teleportal/server";
import { pino } from "pino";

const pinoLogger = pino({
  level: "info",
});

const isProduction = Bun.env.NODE_ENV === "production";

const sinks: Record<string, Sink> = {
  console: getConsoleSink(),
};

if (isProduction) {
  sinks.pino = getPinoSink(pinoLogger);
}

await configure({
  sinks,
  loggers: [
    {
      category: ["teleportal", "playground"],
      sinks: [isProduction ? "pino" : "console"],
      lowestLevel: isProduction ? "info" : "debug",
    },
  ],
});

export const logger = augmentLogger(getLogger(["teleportal", "playground"]));
