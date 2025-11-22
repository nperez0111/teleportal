import { AckMessage, ClientContext, FileMessage, Message } from "teleportal";
import { noopTransport, withPassthrough } from "../passthrough";
import { withSendFile } from "./send-file";

const CHUNK_SIZE = 64 * 1024;

const transportReadMessages: Message<ClientContext>[] = [];
const transportWriteMessages: Message<ClientContext>[] = [];
const transport = withPassthrough<ClientContext, {}>(noopTransport(), {
  onRead: (chunk) => {
    transportReadMessages.push(chunk);
  },
  onWrite: (chunk) => {
    transportWriteMessages.push(chunk);
  },
});
const wrappedTransport = withSendFile({
  transport: transport,
});

const writer = wrappedTransport.writable.getWriter();
const receivedMessages: Message<ClientContext>[] = [];
wrappedTransport.readable.pipeTo(
  new WritableStream({
    write: (chunk) => {
      receivedMessages.push(chunk);
    },
  }),
);

// start the upload, but we need to act as the server in-between, so just wait for it
const uploadPromise = wrappedTransport.upload(
  new File([new Uint8Array(CHUNK_SIZE * 2).fill(42)], "test.txt"),
  "test-file-id",
  false,
);
// let it be received async
await new Promise((resolve) => setTimeout(resolve, 1));

// assert expectation
if (receivedMessages.length !== 1) {
  throw new Error("Expected 1 message, got " + receivedMessages.length);
}
// check what we received
const message = receivedMessages[0] as FileMessage<ClientContext>;

// assert expectation
if (message.payload.type !== "file-upload") {
  throw new Error("Expected file-upload message, got " + message.payload.type);
}
// clear the queue of received messages
receivedMessages.shift();
// act as the server and send a file-download message (acknowledge to allow the upload to continue)
await writer.write(
  new FileMessage({
    type: "file-download",
    fileId: message.payload.fileId,
  }),
);
// let it be received async
await new Promise((resolve) => setTimeout(resolve, 1));
// // assert expectation
// if (receivedMessages.length !== 2) {
//   console.log("receivedMessages", receivedMessages);
//   throw new Error("Expected 2 message, got " + receivedMessages.length);
// }
console.log(
  "receivedMessages",
  receivedMessages.map((m) => m.id),
);
// check what we received
const downloadMessagePart1 = receivedMessages[0] as FileMessage<ClientContext>;
// assert expectation
if (downloadMessagePart1.payload.type !== "file-part") {
  throw new Error(
    "Expected file-part message, got " + downloadMessagePart1.payload.type,
  );
}
// clear the queue of received messages
receivedMessages.shift();

// ACK the file-part message, so the client knows the file-part was received
await writer.write(
  new AckMessage({
    type: "ack",
    messageId: downloadMessagePart1.id,
  }),
);

// check what we received
const downloadMessagePart2 = receivedMessages[0] as FileMessage<ClientContext>;
// assert expectation
if (downloadMessagePart2.payload.type !== "file-part") {
  throw new Error(
    "Expected file-part message, got " + downloadMessagePart2.payload.type,
  );
}
// clear the queue of received messages
receivedMessages.shift();

// ACK the file-part message, so the client knows the file-part was received
await writer.write(
  new AckMessage({
    type: "ack",
    messageId: downloadMessagePart2.id,
  }),
);
console.log("receivedMessages", receivedMessages);
// let it be received async
await new Promise((resolve) => setTimeout(resolve, 1));

// Upload should be complete, so check the client's result
const uploadResult = await uploadPromise;

console.log("completed successfully", uploadResult);
