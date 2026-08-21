import { createStorage } from "unstorage";

import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedBunWebsocketHandler } from "teleportal/websocket-server/bun";

export const manifest = {
  slug: "file-system",
  title: "Collaborative File Explorer",
  description:
    "Drag-and-drop file tree backed by a cycle-free movable tree CRDT with tabbed document editing",
  tags: ["file-tree", "movable-tree", "crdt", "blocknote", "react", "collaboration"],
};

export { default as html } from "./src/index.html";

const memoryStorage = createStorage();

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600,
  issuer: "file-system-example",
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
