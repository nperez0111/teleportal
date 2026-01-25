import { serve } from "crossws/server";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";

import { importEncryptionKey } from "teleportal/encryption-key";
import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";
import { checkPermissionWithTokenManager, Server } from "teleportal/server";
import {
  createEncryptedDriver,
  UnstorageDocumentStorage,
  UnstorageEncryptedDocumentStorage,
  UnstorageFileStorage,
  UnstorageMilestoneStorage,
  UnstorageRateLimitStorage,
} from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

// create an instance of unstorage to store documents, this one just uses in-memory storage for now
const backingStorage = createStorage({
  // encrypted at rest
  driver: createEncryptedDriver(
    // in memory for now
    memoryDriver(),
    // get a crypto key from a JWK string
    importEncryptionKey("s1RZEGnuBelCbov-WC6dvddacpT1pzGmhmeVHKr-1Zg"),
  ),
});

// create a token manager to verify and manage tokens
const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

// create a teleportal server instance
const server = new Server({
  storage(ctx) {
    // if the document is encrypted, use the encrypted storage
    if (ctx.encrypted) {
      return new UnstorageEncryptedDocumentStorage(backingStorage, {
        keyPrefix: "document",
      });
    }
    // otherwise, use the unencrypted storage
    return new UnstorageDocumentStorage(backingStorage, {
      keyPrefix: "document",
      scanKeys: false,
    });
  },
  // add rpc handlers to the protocol
  rpcHandlers: {
    // add milestone support to the protocol, using any storage driver you like
    ...getMilestoneRpcHandlers(new UnstorageMilestoneStorage(backingStorage)),
    // add file-upload support to the protocol, using any storage driver you like
    ...getFileRpcHandlers(new UnstorageFileStorage(backingStorage)),
  },
  // check token validity & permission on each message
  checkPermission: checkPermissionWithTokenManager(tokenManager),
  // configure rate limiting
  rateLimitConfig: {
    // rules to track rate limiting by
    rules: [
      // by user (across all documents accessed)
      {
        id: "per-user",
        maxMessages: 100, // 100 messages per window
        windowMs: 1000, // 1 second window
        trackBy: "user",
      },
      // or, by document (across all users)
      {
        id: "per-document",
        maxMessages: 500, // 500 messages per window per document
        windowMs: 10000, // 10 second window
        trackBy: "document",
      },
      // or, by a user-document pair
      {
        id: "user-document",
        maxMessages: 100,
        windowMs: 1000,
        trackBy: "user-document",
      },
    ],
    // rate-limiting tracking is single-node by default, if using multiple nodes, they need an external store
    rateLimitStorage: new UnstorageRateLimitStorage(backingStorage),
    // callback when a rate limit is exceeded, user will be disconnected automatically
    onRateLimitExceeded: (details) => {
      console.warn("Rate limit exceeded", details);
    },
    // track message sizes for abuse
    maxMessageSize: 10 * 1024 * 1024, // 10MB as the max acceptable message size
    // callback when a message size limit is exceeded, user is disconnected automatically
    onMessageSizeExceeded: (details) => {
      console.warn("Message size exceeded", details);
    },
  },
});

// listen at a port & start the server
serve({
  // websocket upgrades are denied if the token is invalid
  websocket: tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
  // HTTP requests are denied if the token is invalid
  fetch: tokenAuthenticatedHTTPHandler({
    server,
    tokenManager,
    fetch: async () => {
      // serve the simple page
      const res = await fetch(
        "https://raw.githubusercontent.com/nperez0111/teleportal/refs/heads/main/examples/simple/index.html",
      );
      return new Response(await res.text(), {
        headers: { "Content-Type": "text/html" },
      });
    },
  }),
});
