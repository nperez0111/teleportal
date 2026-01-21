import { serve } from "crossws/server";

import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { YDocStorage } from "teleportal/storage";

const server = new Server({
  storage: new YDocStorage(),
});

serve({
  websocket: {
    upgrade: () => {
      // refuse all upgrade requests (disabling websockets)
      throw new Response("Not found", { status: 404 });
    },
  },
  fetch: getHTTPHandlers({
    server,
    getContext: () => {
      return { userId: "nick", room: "test" };
    },
  }),
});
