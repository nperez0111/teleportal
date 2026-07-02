import { websocketTransport, httpTransport } from "teleportal/providers";
import { ConnectionWorkerManager } from "teleportal/providers/worker";
import type { SerializedConnectionOptions } from "teleportal/providers/worker";

const manager = new ConnectionWorkerManager((options: SerializedConnectionOptions) => {
  if (options.transports && options.transports.length > 0) {
    return options.transports.map((desc) => {
      switch (desc.type) {
        case "websocket":
          return websocketTransport(desc.options);
        case "http":
          return httpTransport(desc.options);
        default:
          throw new Error(`Unknown transport type: ${desc.type}`);
      }
    });
  }
  return [websocketTransport({ timeout: 5000 }), httpTransport()];
});

declare const self: { onconnect: ((event: MessageEvent) => void) | null };

self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  manager.addPort(port);
};
