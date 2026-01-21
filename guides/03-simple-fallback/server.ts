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
    onUpgrade: async (request) => {
      const url = new URL(request.url);
      // based on the query parameter, we decide whether to accept the upgrade
      const useWebSocket = url.searchParams.get("ws") === "true";
      if (useWebSocket) {
        console.log("Accepting upgrade");
        return {
          context: { userId: "nick", room: "test" },
        };
      }
      console.log("Refusing upgrade");
      throw new Response("Not found", { status: 404 });
    },
  }),
  fetch: getHTTPHandlers({
    server,
    getContext: () => {
      return { userId: "nick", room: "test" };
    },
  }),
});
