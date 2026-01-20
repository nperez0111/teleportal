import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { withPassthrough } from "teleportal/transports";
import { Provider, websocket } from "teleportal/providers";

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

const websocketConnection = new websocket.WebSocketConnection({
  url: `ws://localhost:1235/?token=${token}`,
});

await websocketConnection.connected;

const provider = await Provider.create({
  connection: websocketConnection,
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

const numUpdates = 1000; // Adjust as needed
console.log(`Starting load test with ${numUpdates} updates...`);

const startTime = performance.now();

for (let i = 0; i < numUpdates; i++) {
  provider.doc.getText("test").insert(i % 10, "x"); // Vary insertion point
}

const endTime = performance.now();
const totalTime = endTime - startTime;
const updatesPerSecond = numUpdates / (totalTime / 1000);

console.log(totalTime.toFixed(2));

console.log("Final document length:", provider.doc.getText("test").length);

try {
  await provider.destroy();
  console.log("Provider destroyed successfully");
} catch (e) {
  console.error("Error destroying provider:", e);
}

process.exit(0);
