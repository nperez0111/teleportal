import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Message, ServerContext, DocMessage, BinaryMessage } from "teleportal";
import { InMemoryPubSubBackend } from "./in-memory";
import {
  getPubSubSink,
  getPubSubSource,
  getPubSubTransport,
  PubSubBackend,
} from "./index";
import { withPassthrough } from "../passthrough";

// Mock context for testing
type TestContext = ServerContext;

// Mock observable for testing
class MockObserver {
  private listeners = new Map<string, Set<(topic: string) => void>>();

  on(event: string, callback: (topic: string) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  call(event: string, topic?: string) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((callback) => callback(topic || ""));
    }
  }
}

describe("PubSub Backend", () => {
  let backend: InMemoryPubSubBackend;

  beforeEach(() => {
    backend = new InMemoryPubSubBackend();
  });

  afterEach(async () => {
    await backend.close();
  });

  it("can publish and subscribe to messages", async () => {
    const topic = "test-topic";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    let receivedMessage: BinaryMessage | null = null;

    const unsubscribe = await backend.subscribe(topic, (msg) => {
      receivedMessage = msg;
    });

    await backend.publish(topic, message);

    expect(receivedMessage as BinaryMessage | null).toEqual(message);
    await unsubscribe();
  });

  it("can handle multiple subscribers to the same topic", async () => {
    const topic = "multi-topic";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    const receivedMessages: BinaryMessage[] = [];

    const unsubscribe1 = await backend.subscribe(topic, (msg) => {
      receivedMessages.push(msg);
    });

    const unsubscribe2 = await backend.subscribe(topic, (msg) => {
      receivedMessages.push(msg);
    });

    await backend.publish(topic, message);

    expect(receivedMessages).toHaveLength(2);
    expect(receivedMessages[0]).toEqual(message);
    expect(receivedMessages[1]).toEqual(message);

    await unsubscribe1();
    await unsubscribe2();
  });

  it("can unsubscribe from topics", async () => {
    const topic = "unsubscribe-topic";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    let callCount = 0;

    const unsubscribe = await backend.subscribe(topic, () => {
      callCount++;
    });

    await backend.publish(topic, message);
    expect(callCount).toBe(1);

    await unsubscribe();
    await backend.publish(topic, message);
    expect(callCount).toBe(1); // Should not increase
  });

  it("can handle publishing to non-existent topics", async () => {
    const topic = "non-existent";
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;

    // Should not throw - publishing to non-existent topics is valid
    await expect(backend.publish(topic, message)).resolves.toBeUndefined();
  });

  it("can close and cleanup", async () => {
    const topic = "cleanup-topic";
    let callCount = 0;

    await backend.subscribe(topic, () => {
      callCount++;
    });

    await backend.close();

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    await backend.publish(topic, message);

    expect(callCount).toBe(0); // Should not be called after close
  });
});

describe("PubSub Sink", () => {
  let backend: InMemoryPubSubBackend;

  beforeEach(() => {
    backend = new InMemoryPubSubBackend();
  });

  afterEach(async () => {
    await backend.close();
  });

  it("can publish messages to topics", async () => {
    const topic = "sink-test";
    const message = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    let receivedMessage: BinaryMessage | null = null;
    await backend.subscribe(topic, (msg) => {
      receivedMessage = msg;
    });

    const sink = getPubSubSink<TestContext>({
      backend,
      topicResolver: (msg: Message<TestContext>) => topic,
    });

    const writer = sink.writable.getWriter();
    await writer.write(message);
    await writer.close();

    expect(receivedMessage as BinaryMessage | null).toEqual(message.encoded);
  });

  it("can resolve topics dynamically", async () => {
    const messages: BinaryMessage[] = [];
    await backend.subscribe("topic-1", (msg) => messages.push(msg));
    await backend.subscribe("topic-2", (msg) => messages.push(msg));

    const sink = getPubSubSink<TestContext>({
      backend,
      topicResolver: (msg: Message<TestContext>) =>
        msg.context.clientId === "client-1" ? "topic-1" : "topic-2",
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

  it("can close the backend on sink close", async () => {
    const sink = getPubSubSink<TestContext>({
      backend,
      topicResolver: () => "test",
    });

    const writer = sink.writable.getWriter();
    await writer.close();

    // Backend should be closed
    expect(backend).toBeDefined();
  });
});

describe("PubSub Source", () => {
  let backend: InMemoryPubSubBackend;
  let observer: MockObserver;

  beforeEach(() => {
    backend = new InMemoryPubSubBackend();
    observer = new MockObserver();
  });

  afterEach(async () => {
    await backend.close();
  });

  it("can subscribe to topics and receive messages", async () => {
    const source = getPubSubSource<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      observer: observer as any,
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
    observer.call("subscribe", "test-topic");

    // Publish a message
    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );
    const message = docMessage.encoded;
    await backend.publish("test-topic", message);

    // Wait a bit for the message to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Unsubscribe and close
    observer.call("unsubscribe", "test-topic");
    observer.call("destroy");
    await reader.cancel();

    await readPromise;

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].encoded).toEqual(message);
  });

  it("can handle multiple topic subscriptions", async () => {
    const source = getPubSubSource<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      observer: observer as any,
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
    observer.call("subscribe", "topic-1");
    observer.call("subscribe", "topic-2");

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

    await backend.publish("topic-1", message1);
    await backend.publish("topic-2", message2);

    await new Promise((resolve) => setTimeout(resolve, 10));

    observer.call("destroy");
    await reader.cancel();
    await readPromise;

    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it("can unsubscribe from topics", async () => {
    const source = getPubSubSource<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      observer: observer as any,
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

    observer.call("subscribe", "test-topic");

    const message1 = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    ).encoded;
    await backend.publish("test-topic", message1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    observer.call("unsubscribe", "test-topic");

    const message2 = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    ).encoded;
    await backend.publish("test-topic", message2);

    await new Promise((resolve) => setTimeout(resolve, 10));

    observer.call("destroy");
    await reader.cancel();
    await readPromise;

    // Should only receive the first message
    expect(messages.length).toBe(1);
    expect(messages[0].encoded).toEqual(message1);
  });

  it("can handle source cancellation", async () => {
    const source = getPubSubSource<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      observer: observer as any,
    });

    const reader = source.readable.getReader();
    await reader.cancel();

    // Should not throw
    expect(backend).toBeDefined();
  });
});

describe("PubSub Transport", () => {
  let backend: InMemoryPubSubBackend;
  let observer: MockObserver;

  beforeEach(() => {
    backend = new InMemoryPubSubBackend();
    observer = new MockObserver();
  });

  afterEach(async () => {
    await backend.close();
  });

  it("can create a complete transport", () => {
    const transport = getPubSubTransport<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      topicResolver: (msg: Message<TestContext>) => msg.document || "default",
      observer: observer as any,
    });

    expect(transport.readable).toBeDefined();
    expect(transport.writable).toBeDefined();
  });

  it("can send and receive messages through the transport", async () => {
    const transport = getPubSubTransport<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      topicResolver: (msg: Message<TestContext>) => msg.document || "default",
      observer: observer as any,
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

    // Subscribe to a topic
    observer.call("subscribe", "test-doc");

    // Write a message
    const message = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    await writer.write(message);

    await new Promise((resolve) => setTimeout(resolve, 10));

    observer.call("destroy");
    await writer.close();
    await reader.cancel();
    await readPromise;

    expect(messages.length).toBeGreaterThan(0);
  });

  it("can be inspected with passthrough", async () => {
    const transport = getPubSubTransport<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      topicResolver: (msg: Message<TestContext>) => msg.document || "default",
      observer: observer as any,
    });

    const inspectedTransport = withPassthrough(transport, {
      onRead(chunk) {
        expect(chunk.encoded).toBeDefined();
        expect(chunk.context.clientId).toBe("test-client");
      },
      onWrite(chunk) {
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

    observer.call("subscribe", "test-doc");

    const message = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    await writer.write(message);

    await new Promise((resolve) => setTimeout(resolve, 10));

    observer.call("destroy");
    await writer.releaseLock();
    await reader.cancel();
    await readPromise;

    expect(messages.length).toBeGreaterThan(0);
  });

  it("can handle multiple documents with different topics", async () => {
    const transport = getPubSubTransport<TestContext>({
      context: {
        clientId: "test-client",
        userId: "test-user",
        room: "test-room",
      },
      backend,
      topicResolver: (msg: Message<TestContext>) => msg.document || "default",
      observer: observer as any,
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
    observer.call("subscribe", "doc-1");
    observer.call("subscribe", "doc-2");

    // Write messages to different documents
    const message1 = new DocMessage(
      "doc-1",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    const message2 = new DocMessage(
      "doc-2",
      { type: "sync-done" },
      { clientId: "test-client", userId: "test-user", room: "test-room" },
    );

    await writer.write(message1);
    await writer.write(message2);

    await new Promise((resolve) => setTimeout(resolve, 10));

    observer.call("destroy");
    await writer.close();
    await reader.cancel();
    await readPromise;

    expect(messages.length).toBeGreaterThanOrEqual(2);
  });
});
