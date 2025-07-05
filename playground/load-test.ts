import { websocket } from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { withPassthrough } from "teleportal/transports";

const token = await createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
}).createToken(
  "nick",
  "docs",
  // TODO probably make token gen configurable callback
  new DocumentAccessBuilder()
    .admin("*")
    // .write("Testy")
    // .readOnly("test-this")
    .build(),
);

const websocketClient = new websocket.WebsocketConnection({
  url: `ws://localhost:1234/?token=${token}`,
});

await websocketClient.connected;

const provider = await websocket.Provider.create({
  client: websocketClient,
  document: "test-load",
  getTransport({ getDefaultTransport }) {
    return withPassthrough(getDefaultTransport(), {
      onWrite() {
        console.count("write");
      },
      onRead() {
        console.count("read");
      },
    });
  },
});

await provider.synced;
for (let i = 0; i < 100000; i++) {
  console.log("writing");
  provider.doc.getText("test").insert(1, "abc");
  await new Promise((r) => setTimeout(r, 1));
}
setTimeout(() => {
  console.log(provider.doc.getText("test").toJSON());
  provider.destroy();
}, 0);
