// polyfill for bun?
import { EventSource } from "eventsource";
import { DocMessage, Message, Observable, StateVector } from "teleportal";
import { decodeHTTPRequest } from "teleportal/http";
import {
  compose,
  getHTTPSink,
  getSSESource,
  getYTransportFromYDoc,
  sync,
  withLogger,
} from "teleportal/transports";

import * as Y from "yjs";

const url = "http://localhost:3000";

const observer = new Observable<{
  message: (message: Message[]) => void;
}>();
const transport = withLogger(
  compose(
    getSSESource(new EventSource(url + "/sse"), {
      clientId: "local",
    }),
    getHTTPSink({
      request: async ({ requestOptions }) => {
        const messages = await fetch(url + "/message", requestOptions).then(
          decodeHTTPRequest,
        );
        console.log("http got back", messages);
        observer.call("message", messages);
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

yTransport.readable
  .pipeThrough(openWithMessageStream)
  .pipeTo(transport.writable);
transport.readable.pipeThrough(httpWriterStream).pipeTo(yTransport.writable);

await yTransport.synced;

yTransport.ydoc.getText("test").insert(1, "abc");

setTimeout(() => {
  console.log(yTransport.ydoc.getText("test").toJSON());
}, 0);
