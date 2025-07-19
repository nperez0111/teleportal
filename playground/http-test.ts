// polyfill for bun?
import { EventSource } from "eventsource";
import { DocMessage, Message, Observable, StateVector } from "teleportal";
import { decodeHTTPRequest } from "teleportal/http";
import {
  compose,
  getHTTPSink,
  getSSESource,
  getYTransportFromYDoc,
  withLogger,
} from "teleportal/transports";

import * as Y from "yjs";

const url = "http://localhost:3000";

const observer = new Observable<{
  message: (message: Message[]) => void;
}>();
const context = { clientId: "abc-123" };
const transport = compose(
  getSSESource({
    context,
    source: new EventSource(url + "/sse?documents=test-load"),
  }),
  getHTTPSink({
    context,
    request: async ({ requestOptions }) => {
      const USE_SSE_PUBLISH = false;
      if (USE_SSE_PUBLISH) {
        const resp = await fetch(url + "/sse", requestOptions);
        if (!resp.ok) {
          throw new Error("Failed to fetch");
        }
      } else {
        const resp = await fetch(url + "/message", requestOptions);
        if (!resp.ok) {
          throw new Error("Failed to fetch");
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

await yTransport.synced;

yTransport.ydoc.getText("test").insert(1, "abc");

setTimeout(() => {
  console.log(yTransport.ydoc.getText("test").toJSON());
}, 100);
