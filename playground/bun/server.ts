import crossws from "crossws/adapters/bun";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
// @ts-ignore - unstorage driver types can't be resolved via exports but work at runtime
import dbDriver from "unstorage/drivers/db0";
import "../src/backend/logger";
import { Server } from "teleportal/server";
import { createUnstorage } from "teleportal/storage";
import {
  checkPermissionWithTokenManager,
  createTokenManager,
  TokenPayload,
} from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
import {
  getHealthHandler,
  getMetricsHandler,
  getStatusHandler,
} from "teleportal/monitoring";
import { createEncryptedDriver } from "teleportal/storage";
import { importEncryptionKey } from "teleportal/encryption-key";

import homepage from "../src/index.html";
// import { RedisPubSub } from "teleportal/transports/redis";

const key = await importEncryptionKey(
  "s1RZEGnuBelCbov-WC6dvddacpT1pzGmhmeVHKr-1Zg",
);
const db = createDatabase(
  bunSqlite({
    name: "yjs.db",
  }),
);

const storage = createStorage({
  driver: createEncryptedDriver(
    dbDriver({
      database: db,
      tableName: "yjs",
    }),
    () => key,
  ),
});

const memoryStorage = createStorage();

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server<TokenPayload & { clientId: string }>({
  getStorage: async (ctx) => {
    // return ctx.encrypted ? new EncryptedMemoryStorage() : new YDocStorage();
    // In production, use the memory storage, I don't want your files
    const backingStorage =
      Bun.env.NODE_ENV === "production" ? memoryStorage : storage;

    const { documentStorage } = createUnstorage(backingStorage, {
      fileKeyPrefix: "file",
      encrypted: ctx.documentId.includes("encrypted"),
      scanKeys: false,
    });
    return documentStorage;
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
  // pubSub: new RedisPubSub({
  //   path: "redis://127.0.0.1:6379",
  // }),
});

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
);

const healthHandler = getHealthHandler(server);
const metricsHandler = getMetricsHandler(server);
const statusHandler = getStatusHandler(server);

const instance = Bun.serve({
  development: {
    // hmr: false,
  },
  routes:
    Bun.env.NODE_ENV !== "production"
      ? {
          // In development, serve the homepage
          "/": homepage,
        }
      : undefined,
  websocket: ws.websocket,
  async fetch(request, bunServer) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, bunServer);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const distDir = import.meta.dir + "/../dist";

    // Monitoring endpoints
    if (pathname === "/health") {
      return await healthHandler(request);
    }

    if (pathname === "/metrics") {
      return await metricsHandler(request);
    }

    if (pathname === "/status") {
      return await statusHandler(request);
    }

    // Just serve the index.html file for the root path
    if (pathname === "/") {
      return new Response(Bun.file(distDir + "/index.html"));
    }

    // Look in the dist folder for the file
    const filePath = distDir + pathname;
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    // Otherwise, just return a 404
    return new Response("Not Found", { status: 404 });
  },
});

console.info(`Server running on http://${instance.hostname}:${instance.port}`);
