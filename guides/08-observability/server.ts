import { serve } from "crossws/server";

import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { YDocStorage } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const server = new Server({
  storage: new YDocStorage(),
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
  // HTTP handlers has endpoints for observability too
  // - GET `/health` - Health endpoint for checking the health of the server.
  // - GET `/metrics` - Metrics endpoint for checking the metrics of the server.
  // - GET `/status` - Status endpoint for checking the status of the server.
  fetch: getHTTPHandlers({
    server,
    getContext: () => {
      return { userId: "nick", room: "test" };
    },
  }),
});
