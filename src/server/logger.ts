import pino from "pino";

export const logger = pino({}).child({
  app: "teleportal-server",
});

export type Logger = pino.Logger;
