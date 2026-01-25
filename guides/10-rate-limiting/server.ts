import { serve } from "crossws/server";
import { createStorage } from "unstorage";

import { Server } from "teleportal/server";
import {
  UnstorageDocumentStorage,
  UnstorageRateLimitStorage,
} from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const storage = createStorage();

const server = new Server({
  storage: new UnstorageDocumentStorage(storage),
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
    rateLimitStorage: new UnstorageRateLimitStorage(storage),
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

serve({
  websocket: getWebsocketHandlers({
    server,
    onUpgrade: async () => {
      return {
        context: { userId: "nick", room: "test" },
      };
    },
  }),
  fetch: async () => {
    const res = await fetch(
      "https://raw.githubusercontent.com/nperez0111/teleportal/refs/heads/main/examples/simple/index.html",
    );
    return new Response(await res.text(), {
      headers: { "Content-Type": "text/html" },
    });
  },
});
