import crossws from "crossws/adapters/bun";
import { createStorage } from "unstorage";

import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

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
      keyPrefix: "document",
      encrypted: ctx.encrypted,
    });
  },

  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

const ws = crossws({
  hooks: tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
});

const httpHandlers = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
});

const instance = Bun.serve({
  port: Bun.env.PORT ? Number(Bun.env.PORT) : 3000,
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
