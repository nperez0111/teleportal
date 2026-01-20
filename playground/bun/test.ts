import { serve } from "crossws/server";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";

import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import {
  createEncryptedDriver,
  UnstorageDocumentStorage,
} from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
import { importEncryptionKey } from "teleportal/encryption-key";

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server({
  storage: new UnstorageDocumentStorage(
    createStorage({
      driver: createEncryptedDriver(
        memoryDriver(),
        importEncryptionKey("s1RZEGnuBelCbov-WC6dvddacpT1pzGmhmeVHKr-1Zg"),
      ),
    }),
  ),
  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

serve({
  websocket: tokenAuthenticatedWebsocketHandler({ server, tokenManager }),
  fetch: tokenAuthenticatedHTTPHandler({ server, tokenManager }),
});
