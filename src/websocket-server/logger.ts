import pino from "pino";

export const logger = pino({}).child({
  app: "websocket-server",
});

export type Logger = pino.Logger;
