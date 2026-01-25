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
  fetch: async () => {
    const res = await fetch(
      "https://raw.githubusercontent.com/nperez0111/teleportal/refs/heads/main/examples/simple/index.html",
    );
    return new Response(await res.text(), {
      headers: { "Content-Type": "text/html" },
    });
  },
});
