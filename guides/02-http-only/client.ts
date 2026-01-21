import { EventSource } from "eventsource";
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  // we always dial WebSocket first, and fall back to HTTP if it fails
  url: `http://localhost:3000`,
  // bun requires a polyfill for EventSource
  httpOptions: { EventSource },
  document: "test",
});

await provider.synced;

provider.doc.getText("test").insert(0, "Hello, world!");

console.log(provider.doc.getText("test").toString());

provider.doc.on("update", () => {
  console.log(provider.doc.getText("test").toString());
});
