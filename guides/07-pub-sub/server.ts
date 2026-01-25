import { serve } from "crossws/server";
import { InMemoryPubSub } from "teleportal";

import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { YDocStorage } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

// This pubSub is the only thing shared between the two servers
// It can be replaced with a Redis, RabbitMQ, etc. pubSub implementation for multi-node deployments
const pubSub = new InMemoryPubSub();

const server1 = new Server({
  // each server has its own storage (in-memory in this example)
  storage: new YDocStorage(),
  pubSub,
});

serve({
  websocket: getWebsocketHandlers({
    server: server1,
    onUpgrade: async () => {
      return {
        context: { userId: "nick", room: "test" },
      };
    },
  }),
  fetch: getHTTPHandlers({
    server: server1,
    getContext: () => {
      return { userId: "nick", room: "test" };
    },
    fetch: async () => {
      const res = await fetch(
        "https://raw.githubusercontent.com/nperez0111/teleportal/refs/heads/main/examples/simple/index.html",
      );
      return new Response(await res.text(), {
        headers: { "Content-Type": "text/html" },
      });
    },
  }),
  // each server runs on a different port
  port: 3000,
});

const server2 = new Server({
  // each server has its own storage (in-memory in this example)
  storage: new YDocStorage(),
  pubSub,
});

serve({
  websocket: getWebsocketHandlers({
    server: server2,
    onUpgrade: async () => {
      return {
        context: { userId: "nick", room: "test" },
      };
    },
  }),
  fetch: getHTTPHandlers({
    server: server2,
    getContext: () => {
      return { userId: "nick", room: "test" };
    },
    fetch: async () => {
      const res = await fetch(
        "https://raw.githubusercontent.com/nperez0111/teleportal/refs/heads/main/examples/simple/index.html",
      );
      return new Response(await res.text(), {
        headers: { "Content-Type": "text/html" },
      });
    },
  }),
  // each server runs on a different port
  port: 3001,
});
