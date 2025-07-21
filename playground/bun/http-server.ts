import { createStorage } from "unstorage";

import { Server } from "teleportal/server";
import {
  EncryptedDocumentStorage,
  UnstorageDocumentStorage,
} from "teleportal/storage";
import { getHTTPHandler } from "teleportal/http";

import { logger } from "../src/backend/logger";
import homepage from "../src/index.html";
import {
  checkPermissionWithTokenManager,
  createTokenManager,
} from "teleportal/token";

const memoryStorage = createStorage();
const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server({
  getStorage: async (ctx) => {
    if (ctx.document.includes("encrypted")) {
      return new EncryptedDocumentStorage(memoryStorage);
    }
    return new UnstorageDocumentStorage(memoryStorage);
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
  logger: logger,
});

const httpHandlers = getHTTPHandler({
  server,
  getContext: async () => {
    return { userId: "123", room: "123" };
  },
});

const instance = Bun.serve({
  routes: {
    "/": homepage,
  },
  async fetch(request) {
    return httpHandlers(request);
  },
});

console.log(`Server running on http://${instance.hostname}:${instance.port}`);
