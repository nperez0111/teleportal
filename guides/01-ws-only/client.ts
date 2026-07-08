import { Provider, websocketTransport } from "teleportal/providers";
import { importEncryptionKey } from "teleportal/encryption-key";

// Use a fixed key so all clients can decrypt each other's changes
const SHARED_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";

const provider = await Provider.create({
  url: `ws://localhost:3000`,
  document: "test",
  encryptionKey: await importEncryptionKey(SHARED_KEY),
  transports: [websocketTransport()],
});

await provider.synced;

const text = provider.doc.getText("test");
const currentContent = text.toString();
console.log("Before insert:", JSON.stringify(currentContent));

text.insert(0, "Hello, world!");

const afterContent = text.toString();
console.log("After insert:", JSON.stringify(afterContent));

// Wait a bit for the Y.js update event to fire
await new Promise((resolve) => setTimeout(resolve, 10));

// Flush pending messages before cleanup
await provider.flush();
await provider.destroy();
