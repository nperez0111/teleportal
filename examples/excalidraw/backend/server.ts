import crossws from "crossws/adapters/bun";
import { createStorage } from "unstorage";

import { getHTTPHandler } from "teleportal/http";
import { Server } from "teleportal/server";
import {
  UnstorageEncryptedDocumentStorage,
  UnstorageDocumentStorage,
} from "teleportal/storage";
import {
  checkPermissionWithTokenManager,
  createTokenManager,
} from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

import homepage from "../src/index.html";

const memoryStorage = createStorage();

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server({
  getStorage: async (ctx) => {
    if (ctx.document.includes("encrypted")) {
      return new UnstorageEncryptedDocumentStorage(memoryStorage);
    }
    return new UnstorageDocumentStorage(memoryStorage);
  },

  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
);

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
  websocket: ws.websocket,
  async fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, server);
    }

    return httpHandlers(request);
  },
});

console.info(`Server running on http://${instance.hostname}:${instance.port}`);
