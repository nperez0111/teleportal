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
const transport = withLogger(
  compose(
    getSSESource({
      context,
      source: new EventSource(url + "/sse?documents=test-load"),
    }),
    getHTTPSink({
      context,
      request: async ({ requestOptions }) => {
        await fetch(url + "/message", requestOptions)
          .then(decodeHTTPRequest)
          .then((readable) =>
            readable.pipeTo(
              new WritableStream({
                write(message) {
                  console.log("http got back", message);
                  message.context.clientId = context.clientId;
                  observer.call("message", [message]);
                },
              }),
            ),
          );
      },
    }),
  ),
);

const yTransport = getYTransportFromYDoc({
  ydoc: new Y.Doc(),
  document: "test-load",
});

const openWithMessageStream = new TransformStream<Message, Message>({
  start(controller) {
    // artificially delay the open message to ensure the sse transport is ready
    setTimeout(() => {
      controller.enqueue(
        new DocMessage("test-load", {
          type: "sync-step-1",
          sv: Y.encodeStateVector(yTransport.ydoc) as StateVector,
        }),
      );
    }, 250);
  },
});
const httpWriterStream = new TransformStream<Message, Message>({
  start(controller) {
    observer.on("message", (messages) => {
      for (const message of messages) {
        // controller.enqueue(message);
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
}, 0);
