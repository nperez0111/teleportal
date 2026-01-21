import { serve } from "crossws/server";

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
  fetch: () => new Response("Not found", { status: 404 }),
});
