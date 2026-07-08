import { Provider, websocketTransport } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

const provider = await Provider.create({
  url: `ws://localhost:3000`,
  document: "test",
  encryptionKey: createEncryptionKey(),
  transports: [websocketTransport()],
});

await provider.synced;

provider.doc.getText("test").insert(0, "Hello, world!");

console.log(provider.doc.getText("test").toString());

provider.doc.on("update", () => {
  console.log(provider.doc.getText("test").toString());
});

// Flush pending messages before cleanup
await provider.flush();
await provider.destroy();
