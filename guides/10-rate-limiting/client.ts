import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: `ws://localhost:3000`,
  document: "test",
});

await provider.synced;

let totalMessages = 1000;
while (totalMessages > 0) {
  provider.doc.getText("test").insert(0, "Hello, world!");
  await new Promise((r) => setTimeout(r, 1));
}

provider.doc.on("update", () => {
  console.log(provider.doc.getText("test").toString());
});
