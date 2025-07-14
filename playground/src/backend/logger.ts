import { PinoTransport } from "@loglayer/transport-pino";
import {
  getSimplePrettyTerminal,
  moonlight,
} from "@loglayer/transport-simple-pretty-terminal";
import { LogLayer } from "loglayer";
import { pino } from "pino";

const p = pino({
  level: "info",
});

export const logger = new LogLayer({
  transport: [
    new PinoTransport({
      logger: p,
      enabled: Bun.env.NODE_ENV === "production",
    }),
    getSimplePrettyTerminal({
      enabled: Bun.env.NODE_ENV !== "production",
      runtime: "node", // Required: "node" or "browser"
      viewMode: "expanded", // "inline" | "message-only" | "expanded"
      theme: moonlight,
      level: "trace",
    }),
  ],
});
