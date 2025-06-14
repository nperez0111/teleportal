import { uuidv4 } from "lib0/random.js";
import * as Y from "yjs";
import {
  type BinaryMessage,
  DocMessage,
  type StateVector,
} from "../src/protocol";
import { getYDocTransport } from "../src/transports/ydoc";

const doc = new Y.Doc();
const transport = getYDocTransport({
  ydoc: doc,
  document: "test",
  debug: true,
});

transport.awareness.setLocalStateField("user", {
  name: uuidv4(),
  color: "#" + Math.floor(Math.random() * 16777215).toString(16),
});
transport.awareness.on("update", () => {
  console.log("awareness update", transport.awareness.getStates());
});

const ws = new WebSocket("ws://localhost:1234/_ws");
const writer = transport.writable.getWriter();
ws.addEventListener("open", () => {
  console.log("Connected to websocket server");

  transport.readable.pipeTo(
    new WritableStream({
      write(chunk) {
        ws.send(chunk);
      },
    }),
  );

  ws.send(
    new DocMessage("test", {
      type: "sync-step-1",
      sv: Y.encodeStateVectorFromUpdateV2(
        Y.encodeStateAsUpdateV2(doc),
      ) as StateVector,
    }).encoded,
  );
});

ws.addEventListener("message", async (event) => {
  const message = event.data as BinaryMessage;
  console.log("Received message:", message);
  await writer.write(message);

  console.log("Now: " + getText());
});

ws.addEventListener("close", () => {
  console.log("Disconnected from websocket server");
});

ws.addEventListener("error", (error) => {
  console.error("WebSocket error:", error);
});

await new Promise((resolve) => setTimeout(resolve, 100));

function getText() {
  return doc.getText("test").toString();
}
let prompt = getText();
process.stdout.write("Now: " + prompt + "\n");
for await (const line of console) {
  doc.transact(() => {
    doc.getText("test").delete(0, prompt.length);
    doc.getText("test").insert(0, line);
  });
  prompt = line;
  process.stdout.write("Now: " + getText() + "\n");
}
await new Promise((resolve) => setTimeout(resolve, 1000));
ws.close();
doc.destroy();
