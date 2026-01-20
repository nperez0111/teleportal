// polyfill for bun?
import { EventSource } from "eventsource";
import { DocMessage, Message, Observable, StateVector } from "teleportal";
import { decodeHTTPRequest } from "teleportal/http";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import {
  compose,
  getHTTPSink,
  getSSESource,
  getYTransportFromYDoc,
} from "teleportal/transports";

import * as Y from "yjs";

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

const url = `http://localhost:3000`;

const observer = new Observable<{
  message: (message: Message[]) => void;
}>();
const context = { clientId: "abc-123" };
const transport = compose(
  getSSESource({
    context,
    source: new EventSource(url + `/sse?documents=test-load&token=${token}`),
  }),
  getHTTPSink({
    context,
    request: async ({ requestOptions }) => {
      const USE_SSE_PUBLISH = false;
      if (USE_SSE_PUBLISH) {
        const resp = await fetch(url + `/sse?token=${token}`, requestOptions);
        if (!resp.ok) {
          console.log(await resp.json());
          throw new Error("Failed to post to /sse");
        }
      } else {
        const resp = await fetch(
          url + `/message?token=${token}`,
          requestOptions,
        );
        if (!resp.ok) {
          throw new Error("Failed to post to /message");
        }

        const readable = decodeHTTPRequest(resp);

        await readable.pipeTo(
          new WritableStream({
            async write(message) {
              await observer.call("message", [message]);
            },
          }),
        );
      }
    },
  }),
);

const yTransport = getYTransportFromYDoc({
  ydoc: new Y.Doc(),
  document: "test-load",
});

const openWithMessageStream = new TransformStream<Message, Message>({
  async start(controller) {
    // Wait until we know the clientId to send the open message
    const clientId = await transport.clientId;
    context.clientId = clientId;

    controller.enqueue(
      new DocMessage("test-load", {
        type: "sync-step-1",
        sv: Y.encodeStateVector(yTransport.ydoc) as StateVector,
      }),
    );
  },
});
const httpWriterStream = new TransformStream<Message, Message>({
  start(controller) {
    observer.on("message", (messages) => {
      for (const message of messages) {
        controller.enqueue(message);
      }
    });
  },
});

transport.readable.pipeThrough(httpWriterStream).pipeTo(yTransport.writable);
yTransport.readable
  .pipeThrough(openWithMessageStream)
  .pipeTo(transport.writable);

console.log("before synced");
await yTransport.synced;
console.log("after synced");

yTransport.ydoc.getText("test").insert(1, "abc");

setInterval(() => {
  console.log(yTransport.ydoc.getText("test").toJSON());
}, 1000);
