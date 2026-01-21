import { serve } from "crossws/server";

import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { checkPermissionWithTokenManager, Server } from "teleportal/server";
import { YDocStorage } from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

// token manager is a JWT token verifier and manager.
const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server({
  storage: new YDocStorage(),
  // every message is verified against the token's permissions to the document
  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

serve({
  // websocket upgrades are denied if the token is invalid
  websocket: tokenAuthenticatedWebsocketHandler({ server, tokenManager }),
  // HTTP requests are denied if the token is invalid
  fetch: tokenAuthenticatedHTTPHandler({ server, tokenManager }),
});
