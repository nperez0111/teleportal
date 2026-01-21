import { EventSource } from "eventsource";
import { Provider } from "teleportal/providers";

// just for illustration, we use a random number to decide which server to use
const serverPort = Math.random() < 0.5 ? 3000 : 3001;

console.log("using server on port:", serverPort);

const provider = await Provider.create({
  url: `http://localhost:${serverPort}`,
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
