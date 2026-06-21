import { EventSource } from "eventsource";
import { Provider, httpTransport } from "teleportal/providers";

const provider = await Provider.create({
  url: `http://localhost:3000`,
  // use only HTTP transport; bun requires a polyfill for EventSource
  transports: [httpTransport({ EventSource })],
  document: "test",
});

await provider.synced;

provider.doc.getText("test").insert(0, "Hello, world!");

console.log(provider.doc.getText("test").toString());

provider.doc.on("update", () => {
  console.log(provider.doc.getText("test").toString());
});
