import { EventSource } from "eventsource";
import { Provider } from "teleportal/providers";

// just for illustration, we use a random boolean to decide whether to use WebSocket or HTTP
const useWebSocket = Math.random() < 0.5;
const provider = await Provider.create({
  // we always dial WebSocket first, and fall back to HTTP if it fails
  url: `http://localhost:3000?ws=${useWebSocket}`,
  // bun requires a polyfill for EventSource
  httpOptions: { EventSource },
  document: "test",
});

await provider.synced;
console.log("using", provider.connectionType);
provider.doc.getText("test").insert(0, "Hello, world!");

console.log(provider.doc.getText("test").toString());

provider.doc.on("update", () => {
  console.log(provider.doc.getText("test").toString());
});
