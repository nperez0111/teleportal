/**
 * SharedWorker entry point.
 *
 * Users build and serve this file as their worker script:
 *
 *   new SharedWorker(new URL("./teleportal-worker.js", import.meta.url))
 *
 * The worker holds the real Connection and WebSocket, shared across all tabs.
 */
import { websocketTransport } from "../transports/websocket";
import { httpTransport } from "../transports/http";
import { ConnectionWorkerManager } from "./connection-worker-manager";
import type { SerializedConnectionOptions } from "./protocol";

const manager = new ConnectionWorkerManager((options: SerializedConnectionOptions) => {
  if (options.transports && options.transports.length > 0) {
    return options.transports.map((desc) => {
      switch (desc.type) {
        case "websocket":
          return websocketTransport(desc.options);
        case "http":
          return httpTransport(desc.options);
        default:
          throw new Error(`Unknown transport type: ${(desc as any).type}`);
      }
    });
  }
  return [websocketTransport({ timeout: 5000 }), httpTransport()];
});

declare const self: {
  onconnect: ((event: MessageEvent) => void) | null;
};

self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  manager.addPort(port);
};
