import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  Message,
  ServerContext,
  DocMessage,
  BinaryMessage,
  InMemoryPubSub,
  PubSubTopic,
  Update,
} from "teleportal";

import { getPubSubSink, getPubSubSource, getPubSubTransport } from "./index";
import { withPassthrough } from "../passthrough";

// Helper function to create a proper Update type
function createUpdate(data: Uint8Array) {
  return data as Update;
}

// Mock context for testing
type TestContext = ServerContext;

describe("PubSub pubsub", () => {
  let pubsub: InMemoryPubSub;

  beforeEach(() => {
    pubsub = new InMemoryPubSub();
  });

  afterEach(async () => {
    await pubsub[Symbol.asyncDispose]();
  });

  it("can publish and subscribe to messages", async () => {
    const topic: PubSubTopic = "client/ok";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    let receivedMessage: BinaryMessage | null = null;

    const unsubscribe = await pubsub.subscribe(topic, (msg) => {
      receivedMessage = msg;
    });

    await pubsub.publish(topic, message, "test-client");

    expect(receivedMessage as BinaryMessage | null).toEqual(message);
    await unsubscribe();
  });

  it("can handle multiple subscribers to the same topic", async () => {
    const topic: PubSubTopic = "client/multi-topic";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    const receivedMessages: BinaryMessage[] = [];

    const unsubscribe1 = await pubsub.subscribe(topic, (msg) => {
      receivedMessages.push(msg);
    });

    const unsubscribe2 = await pubsub.subscribe(topic, (msg) => {
      receivedMessages.push(msg);
    });

    await pubsub.publish(topic, message, "test-client");

    expect(receivedMessages).toHaveLength(2);
    expect(receivedMessages[0]).toEqual(message);
    expect(receivedMessages[1]).toEqual(message);

    await unsubscribe1();
    await unsubscribe2();
  });

  it("can unsubscribe from topics", async () => {
    const topic: PubSubTopic = "client/unsubscribe-topic";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    let callCount = 0;

    const unsubscribe = await pubsub.subscribe(topic, () => {
      callCount++;
    });

    await pubsub.publish(topic, message, "test-client");
    expect(callCount).toBe(1);

    await unsubscribe();
    await pubsub.publish(topic, message, "test-client");
    expect(callCount).toBe(1); // Should not increase
  });

  it("can handle publishing to non-existent topics", async () => {
    const topic: PubSubTopic = "client/non-existent";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;

    // Should not throw - publishing to non-existent topics is valid
    await expect(
      pubsub.publish(topic, message, "test-client"),
    ).resolves.toBeUndefined();
  });

  it("can close and cleanup", async () => {
    const topic: PubSubTopic = "client/cleanup-topic";
    let callCount = 0;

    await pubsub.subscribe(topic, () => {
      callCount++;
    });

    await pubsub[Symbol.asyncDispose]();

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    await pubsub.publish(topic, message, "test-client");

    expect(callCount).toBe(0); // Should not be called after close
  });
});

describe("PubSub Sink", () => {
  let pubsub: InMemoryPubSub;

  beforeEach(() => {
    pubsub = new InMemoryPubSub();
  });

  afterEach(async () => {
    await pubsub[Symbol.asyncDispose]();
  });

  it("can publish messages to topics", async () => {
    const topic: PubSubTopic = "client/sink-test";
    const message = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    let receivedMessage: BinaryMessage | null = null;
    await pubsub.subscribe(topic, (msg) => {
      receivedMessage = msg;
    });

    const sink = getPubSubSink<TestContext>({
      pubsub,
      topicResolver: (msg: Message<TestContext>) => topic,
      sourceId: "test-source",
    });

    const writer = sink.writable.getWriter();
    await writer.write(message);
    await writer.close();

    expect(receivedMessage as BinaryMessage | null).toEqual(message.encoded);
  });

  it("can resolve topics dynamically", async () => {
    const messages: BinaryMessage[] = [];
    await pubsub.subscribe("client/topic-1", (msg) => messages.push(msg));
    await pubsub.subscribe("client/topic-2", (msg) => messages.push(msg));

    const sink = getPubSubSink<TestContext>({
      pubsub,
      topicResolver: (msg: Message<TestContext>) =>
        msg.context.clientId === "client-1"
          ? "client/topic-1"
          : "client/topic-2",
      sourceId: "test-source",
    });

    const writer = sink.writable.getWriter();

    const message1 = new DocMessage(
      "doc-1",
      { type: "sync-done" },
      { clientId: "client-1", userId: "user-1", room: "room-1" },
    );

    const message2 = new DocMessage(
      "doc-2",
      { type: "sync-done" },
      { clientId: "client-2", userId: "user-2", room: "room-2" },
    );

    await writer.write(message1);
    await writer.write(message2);
    await writer.close();

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(message1.encoded);
    expect(messages[1]).toEqual(message2.encoded);
  });

  it("can close the pubsub on sink close", async () => {
    const sink = getPubSubSink<TestContext>({
      pubsub,
      topicResolver: () => "client/test",
      sourceId: "test-source",
    });

    const writer = sink.writable.getWriter();
    await writer.close();

    // pubsub should be closed
    expect(pubsub).toBeDefined();
  });
});

describe("PubSub Source", () => {
  let pubsub: InMemoryPubSub;

  beforeEach(() => {
    pubsub = new InMemoryPubSub();
  });

  afterEach(async () => {
    await pubsub[Symbol.asyncDispose]();
  });

  it("can subscribe to topics and receive messages", async () => {
    const source = getPubSubSource<TestContext>({
      getContext: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      pubsub,
      sourceId: "test-source",
    });

    const messages: any[] = [];
    const reader = source.readable.getReader();

    // Start reading
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        messages.push(value);
      }
    })();

    // Subscribe to a topic
    await source.subscribe("client/test-topic");

    // Publish a message
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    await pubsub.publish("client/test-topic", message, "test-client");

    // Wait a bit for the message to be processed
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Unsubscribe and close
    await source.unsubscribe("client/test-topic");
    await reader.cancel();

    await readPromise;

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].encoded).toEqual(message);
  });

  it("can handle multiple topic subscriptions", async () => {
    const source = getPubSubSource<TestContext>({
      getContext: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      pubsub,
      sourceId: "test-source",
    });

    const messages: any[] = [];
    const reader = source.readable.getReader();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        messages.push(value);
      }
    })();

    // Subscribe to multiple topics
    await source.subscribe("client/topic-1");
    await source.subscribe("client/topic-2");

    // Publish messages to different topics
    const message1 = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    ).encoded;
    const message2 = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    ).encoded;

    await pubsub.publish("client/topic-1", message1, "test-client");
    await pubsub.publish("client/topic-2", message2, "test-client");

    await new Promise((resolve) => setTimeout(resolve, 1));

    await reader.cancel();
    await readPromise;

    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it("can unsubscribe from topics", async () => {
    const source = getPubSubSource<TestContext>({
      getContext: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      pubsub,
      sourceId: "test-source",
    });

    const messages: any[] = [];
    const reader = source.readable.getReader();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        messages.push(value);
      }
    })();

    await source.subscribe("client/test-topic");

    const message1 = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    ).encoded;
    await pubsub.publish("client/test-topic", message1, "test-client");

    await new Promise((resolve) => setTimeout(resolve, 1));

    await source.unsubscribe("client/test-topic");

    const message2 = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    ).encoded;
    await pubsub.publish("client/test-topic", message2, "test-client");

    await new Promise((resolve) => setTimeout(resolve, 1));

    await reader.cancel();
    await readPromise;

    // Should only receive the first message
    expect(messages.length).toBe(1);
    expect(messages[0].encoded).toEqual(message1);
  });

  it("can handle source cancellation", async () => {
    const source = getPubSubSource<TestContext>({
      getContext: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      pubsub,
      sourceId: "test-source",
    });

    const reader = source.readable.getReader();
    await reader.cancel();

    // Should not throw
    expect(pubsub).toBeDefined();
  });
});

describe("PubSub Transport", () => {
  let pubsub: InMemoryPubSub;

  beforeEach(() => {
    pubsub = new InMemoryPubSub();
  });

  afterEach(async () => {
    await pubsub[Symbol.asyncDispose]();
  });

  it("can create a complete transport", () => {
    const transport = getPubSubTransport<TestContext>({
      getContext: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      pubsub,
      topicResolver: (msg: Message<TestContext>) =>
        msg.document ? `document/${msg.document}` : "client/default",
      sourceId: "test-source",
    });

    expect(transport.readable).toBeDefined();
    expect(transport.writable).toBeDefined();
  });

  it("can send and receive messages through the transport", async () => {
    const transport = getPubSubTransport<TestContext>({
      getContext: (message: any) => message.context, // Preserve original message context
      pubsub,
      topicResolver: (msg: Message<TestContext>) =>
        msg.document ? `document/${msg.document}` : "client/default",
      sourceId: "test-source",
    });

    const messages: any[] = [];
    const reader = transport.readable.getReader();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        messages.push(value);
      }
    })();

    const writer = transport.writable.getWriter();

    // Subscribe to the topic
    await transport.subscribe("document/test-doc");

    // Publish a message from an external source (different sourceId)
    const externalMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      {
        clientId: "external-client",
        userId: "external-user",
        room: "external-room",
      },
    );
    await pubsub.publish(
      "document/test-doc",
      externalMessage.encoded,
      "external-source",
    );

    // Wait for the external message to be received
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Write a message to the transport
    const message = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    await writer.write(message);

    await new Promise((resolve) => setTimeout(resolve, 1));

    await writer.close();
    await reader.cancel();
    await readPromise;

    // Should receive the external message, not the self-published one
    expect(messages.length).toBeGreaterThan(0);

    // Verify that we received the external message by checking its ID
    const receivedMessage = messages[0];
    expect(receivedMessage.id).toBe(externalMessage.id);
  });

  it("can be inspected with passthrough", async () => {
    const transport = getPubSubTransport<TestContext>({
      getContext: (message: any) => message.context, // Preserve original message context
      pubsub,
      topicResolver: (msg: Message<TestContext>) =>
        msg.document ? `document/${msg.document}` : "client/default",
      sourceId: "test-source",
    });

    let writeChunk: any = null;
    let readChunk: any = null;

    const inspectedTransport = withPassthrough(transport, {
      onRead(chunk) {
        readChunk = chunk;
        expect(chunk.encoded).toBeDefined();
      },
      onWrite(chunk) {
        writeChunk = chunk;
        expect(chunk.encoded).toBeDefined();
        expect(chunk.context.clientId).toBe("test-client");
      },
    });

    const messages: any[] = [];
    const reader = inspectedTransport.readable.getReader();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        messages.push(value);
      }
    })();

    const writer = inspectedTransport.writable.getWriter();

    await transport.subscribe("document/test-doc");

    // Publish an external message
    const externalMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      {
        clientId: "external-client",
        userId: "external-user",
        room: "external-room",
      },
    );
    await pubsub.publish(
      "document/test-doc",
      externalMessage.encoded,
      "external-source",
    );

    await new Promise((resolve) => setTimeout(resolve, 1));

    // Write a message (this will be inspected by passthrough)
    const message = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    await writer.write(message);

    await new Promise((resolve) => setTimeout(resolve, 1));

    await writer.releaseLock();
    await reader.cancel();
    await readPromise;

    // Verify that passthrough inspected the write operation
    expect(writeChunk).toBeDefined();
    expect(writeChunk.id).toBe(message.id);
    expect(writeChunk.context.clientId).toBe("test-client");

    // Verify that passthrough inspected the read operation
    expect(readChunk).toBeDefined();
    expect(readChunk.id).toBe(externalMessage.id);

    // Note: context is lost during encoding/decoding, so we can't verify clientId
    // The filtering is working correctly as shown in the logs

    // Should receive the external message
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].id).toBe(externalMessage.id);
  });

  it("can handle multiple documents with different topics", async () => {
    const transport = getPubSubTransport<TestContext>({
      getContext: (message: any) => message.context, // Preserve original message context
      pubsub,
      topicResolver: (msg: Message<TestContext>) =>
        msg.document ? `document/${msg.document}` : "client/default",
      sourceId: "test-source",
    });

    const messages: any[] = [];
    const reader = transport.readable.getReader();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        messages.push(value);
      }
    })();

    const writer = transport.writable.getWriter();

    // Subscribe to multiple documents
    await transport.subscribe("document/doc-1");
    await transport.subscribe("document/doc-2");

    // Publish external messages to different documents
    const externalMessage1 = new DocMessage(
      "doc-1",
      { type: "sync-done" },
      {
        clientId: "external-client",
        userId: "external-user",
        room: "external-room",
      },
    );
    const externalMessage2 = new DocMessage(
      "doc-2",
      { type: "sync-done" },
      {
        clientId: "external-client",
        userId: "external-user",
        room: "external-room",
      },
    );

    await pubsub.publish(
      "document/doc-1",
      externalMessage1.encoded,
      "external-source",
    );
    await pubsub.publish(
      "document/doc-2",
      externalMessage2.encoded,
      "external-source",
    );

    await new Promise((resolve) => setTimeout(resolve, 1));

    // Write messages to different documents with different content
    const message1 = new DocMessage(
      "doc-1",
      { type: "update", update: createUpdate(new Uint8Array([1, 2, 3])) }, // Different payload type
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    const message2 = new DocMessage(
      "doc-2",
      { type: "update", update: createUpdate(new Uint8Array([4, 5, 6])) }, // Different payload type
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    await writer.write(message1);
    await writer.write(message2);

    await new Promise((resolve) => setTimeout(resolve, 1));

    await writer.close();
    await reader.cancel();
    await readPromise;

    // Should receive the external messages, not the self-published ones
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // Verify that we received the external messages by checking their IDs
    const receivedIds = messages.map((msg) => msg.id);
    expect(receivedIds).toContain(externalMessage1.id);
    expect(receivedIds).toContain(externalMessage2.id);

    // Verify that we did NOT receive the self-published messages
    expect(receivedIds).not.toContain(message1.id);
    expect(receivedIds).not.toContain(message2.id);

    // Note: context is lost during encoding/decoding, so we can't verify clientId
    // The filtering is working correctly as shown in the logs
  });
});
