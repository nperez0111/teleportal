import { Provider } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

const provider = await Provider.create({
  url: `ws://localhost:3000`,
  document: "test",
  encryptionKey: createEncryptionKey(),
});

await provider.synced;

provider.doc.getText("test").insert(0, "Hello, world!");

console.log(provider.doc.getText("test").toString());

provider.doc.on("update", () => {
  console.log(provider.doc.getText("test").toString());
});
