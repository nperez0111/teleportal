import crossws from "crossws/adapters/bun";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
// @ts-ignore - unstorage driver types can't be resolved via exports but work at runtime
import dbDriver from "unstorage/drivers/db0";

import { importEncryptionKey } from "teleportal/encryption-key";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import {
  createEncryptedDriver,
  UnstorageDocumentStorage,
  UnstorageEncryptedDocumentStorage,
  UnstorageFileStorage,
  UnstorageMilestoneStorage,
  UnstorageRateLimitStorage,
  UnstorageTemporaryUploadStorage,
} from "teleportal/storage";
import { createTokenManager, TokenPayload } from "teleportal/token";
import type { RateLimitRule } from "teleportal/transports/rate-limiter";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

import "../src/backend/logger";

import homepage from "../src/index.html";
import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
// import { RedisPubSub } from "teleportal/transports/redis";

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
    importEncryptionKey("s1RZEGnuBelCbov-WC6dvddacpT1pzGmhmeVHKr-1Zg"),
  ),
});

const memoryStorage = createStorage();
// In production, use the memory storage, I don't want your files
const backingStorage =
  Bun.env.NODE_ENV === "production" ? memoryStorage : storage;

const temporaryUploadStorage = new UnstorageTemporaryUploadStorage(
  memoryStorage,
  {
    keyPrefix: "file",
  },
);

const fileStorage = new UnstorageFileStorage(backingStorage, {
  keyPrefix: "file",
  temporaryUploadStorage,
});

const milestoneStorage = new UnstorageMilestoneStorage(backingStorage, {
  keyPrefix: "document-milestone",
});

// Create RPC handlers with storage instances
const milestoneHandlers = getMilestoneRpcHandlers(milestoneStorage);
const fileHandlers = getFileRpcHandlers(fileStorage);

// Create rate limit storage using the same backing storage
const rateLimitStorage = new UnstorageRateLimitStorage(memoryStorage);

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

// Configure rate limit rules
const rateLimitRules: RateLimitRule<TokenPayload & { clientId: string }>[] = [
  {
    id: "per-user",
    maxMessages: 100, // 100 messages per window
    windowMs: 1000, // 1 second window
    trackBy: "user",
  },
  {
    id: "per-document",
    maxMessages: 500, // 500 messages per window per document
    windowMs: 10000, // 10 second window
    trackBy: "document",
  },
];

const server = new Server<TokenPayload & { clientId: string }>({
  storage: async (ctx) => {
    if (ctx.encrypted) {
      return new UnstorageEncryptedDocumentStorage(backingStorage, {
        keyPrefix: "document",
      });
    }
    return new UnstorageDocumentStorage(backingStorage, {
      keyPrefix: "document",
      scanKeys: false,
    });
  },
  rpcHandlers: {
    ...milestoneHandlers,
    ...fileHandlers,
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
  // pubSub: new RedisPubSub({
  //   path: "redis://127.0.0.1:6379",
  // }),
  rateLimitConfig: {
    rules: rateLimitRules,
    rateLimitStorage,
    maxMessageSize: 10 * 1024 * 1024, // 10MB
    getUserId: (message) => message.context?.userId,
    getDocumentId: (message) => message.document,
    onRateLimitExceeded: (details) => {
      console.warn("Rate limit exceeded", details);
    },
    onMessageSizeExceeded: (details) => {
      console.warn("Message size exceeded", details);
    },
  },
});

const ws = crossws({
  hooks: tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
});

const httpHandler = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
});

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

    // Otherwise, check if the request is handled by the HTTP handler
    return httpHandler(request);
  },
});

console.info(`Server running on http://${instance.hostname}:${instance.port}`);
