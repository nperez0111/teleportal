import pino from "pino";

export const logger = pino({}).child({
  app: "match-maker-server",
});

export type Logger = pino.Logger;
