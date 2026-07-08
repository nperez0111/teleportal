import { serve } from "crossws/server";

import { Server } from "teleportal/server";
import { MemoryDocumentStorage } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const storage = new MemoryDocumentStorage();

const server = new Server({
  storage,
});

server.on("document-load", (event) => {
  console.log("[Server] Document loaded:", event.documentId);
});

server.on("session-open", (event) => {
  event.session.on("document-write", () => {
    console.log("[Server] Update received for:", event.documentId);
  });
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
