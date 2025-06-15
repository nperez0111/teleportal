import pino from "pino";

export const logger = pino({}).child({
  app: "y-sync",
});
