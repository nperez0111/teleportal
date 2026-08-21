import { createStorage } from "unstorage";

import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedBunWebsocketHandler } from "teleportal/websocket-server/bun";

export const manifest = {
  slug: "excalidraw",
  title: "Excalidraw Whiteboard",
  description: "Collaborative whiteboard with real-time cursors and E2E encryption",
  tags: ["whiteboard", "drawing", "react", "encryption"],
};

export { default as html } from "./src/index.html";

const memoryStorage = createStorage();

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600,
  issuer: "excalidraw-example",
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

const handler = tokenAuthenticatedBunWebsocketHandler({
  server,
  tokenManager,
  appSlug: manifest.slug,
});

const httpHandler = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
});

export async function fetch(request: Request, bunServer: any) {
  if (request.headers.get("upgrade") === "websocket") {
    return handler.upgrade(request, bunServer);
  }
  return httpHandler(request);
}

export const websocket = handler.websocket;
