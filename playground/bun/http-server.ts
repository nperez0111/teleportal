import { createStorage } from "unstorage";

import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";

import { createTokenManager } from "teleportal/token";
import homepage from "../src/index.html";

const memoryStorage = createStorage();
const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server({
  storage: async (ctx) => {
    return new UnstorageDocumentStorage(memoryStorage, {
      encrypted: ctx.documentId.includes("encrypted"),
    });
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

const httpHandlers = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
});

const instance = Bun.serve({
  routes: {
    "/": homepage,
  },
  fetch: httpHandlers,
});

console.info(`Server running on http://${instance.hostname}:${instance.port}`);
