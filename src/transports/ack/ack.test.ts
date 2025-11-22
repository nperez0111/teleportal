import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  AckMessage,
  AwarenessMessage,
  DocMessage,
  InMemoryPubSub,
  type AwarenessUpdateMessage,
  type PubSubTopic,
  type ServerContext,
  type Sink,
  type StateVector,
  type Update,
  decodeMessage,
} from "teleportal";
import { withAckSink, withAckTrackingSink } from "./index";

type TestContext = ServerContext;

describe("withAckSink", () => {
  let pubSub: InMemoryPubSub;
  let baseSink: Sink<TestContext>;
  let writtenMessages: any[];

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    writtenMessages = [];
    baseSink = {
      writable: new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      }),
    };
  });

  afterEach(async () => {
    await pubSub[Symbol.asyncDispose]();
  });

  it("should send ACK after writing a doc message", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";
    const receivedAcks: any[] = [];

    await pubSub.subscribe(ackTopic, (message) => {
      const decoded = decodeMessage(message);
      if (decoded instanceof AckMessage) {
        receivedAcks.push(decoded);
      }
    });

    const ackSink = withAckSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      context,
    });

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      context,
    );

    const writer = ackSink.writable.getWriter();
    await writer.write(docMessage);
    writer.releaseLock();

    // Wait for ACK to be published
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writtenMessages).toHaveLength(1);
    expect(writtenMessages[0]).toBe(docMessage);
    expect(receivedAcks).toHaveLength(1);
    expect(receivedAcks[0]).toBeInstanceOf(AckMessage);
    expect(receivedAcks[0].payload.messageId).toBe(docMessage.id);
  });

  it("should send ACK after writing an awareness message", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";
    const receivedAcks: any[] = [];

    await pubSub.subscribe(ackTopic, (message) => {
      const decoded = decodeMessage(message);
      if (decoded instanceof AckMessage) {
        receivedAcks.push(decoded);
      }
    });

    const ackSink = withAckSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      context,
    });

    const awarenessMessage = new AwarenessMessage(
      "test-doc",
      {
        type: "awareness-update",
        update: new Uint8Array([
          0x00, 0x01, 0x02, 0x03,
        ]) as AwarenessUpdateMessage,
      },
      context,
    );

    const writer = ackSink.writable.getWriter();
    await writer.write(awarenessMessage);
    writer.releaseLock();

    // Wait for ACK to be published
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writtenMessages).toHaveLength(1);
    expect(writtenMessages[0]).toBe(awarenessMessage);
    expect(receivedAcks).toHaveLength(1);
    expect(receivedAcks[0]).toBeInstanceOf(AckMessage);
    expect(receivedAcks[0].payload.messageId).toBe(awarenessMessage.id);
  });

  it("should not send ACK for ACK messages", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";
    const receivedAcks: any[] = [];

    await pubSub.subscribe(ackTopic, (message) => {
      const decoded = decodeMessage(message);
      if (decoded instanceof AckMessage) {
        receivedAcks.push(decoded);
      }
    });

    const ackSink = withAckSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      context,
    });

    const ackMessage = new AckMessage(
      {
        type: "ack",
        messageId: "some-message-id",
      },
      context,
    );

    const writer = ackSink.writable.getWriter();
    await writer.write(ackMessage);
    writer.releaseLock();

    // Wait for potential ACK to be published
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writtenMessages).toHaveLength(1);
    expect(writtenMessages[0]).toBe(ackMessage);
    // Should not send ACK for ACK messages
    expect(receivedAcks).toHaveLength(0);
  });

  it("should preserve sink properties", () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const sinkWithProps = {
      ...baseSink,
      customProperty: "test-value",
    };

    const ackSink = withAckSink(sinkWithProps, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      context,
    });

    expect((ackSink as any).customProperty).toBe("test-value");
  });

  it("should handle close", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    let closed = false;
    const sinkWithClose = {
      writable: new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
        close() {
          closed = true;
        },
      }),
    };

    const ackSink = withAckSink(sinkWithClose, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      context,
    });

    await ackSink.writable.close();
    expect(closed).toBe(true);
  });

  it("should handle abort", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    let aborted = false;
    const sinkWithAbort = {
      writable: new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
        abort(reason) {
          aborted = true;
        },
      }),
    };

    const ackSink = withAckSink(sinkWithAbort, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      context,
    });

    await ackSink.writable.abort("test reason");
    expect(aborted).toBe(true);
  });
});

describe("withAckTrackingSink", () => {
  let pubSub: InMemoryPubSub;
  let baseSink: Sink<TestContext>;
  let writtenMessages: any[];

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    writtenMessages = [];
    baseSink = {
      writable: new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
      }),
    };
  });

  afterEach(async () => {
    await pubSub[Symbol.asyncDispose]();
  });

  it("should track messages and wait for ACKs", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const trackedSink = withAckTrackingSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      ackTimeout: 1000,
    });

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      context,
    );

    // Write message
    const writer = trackedSink.writable.getWriter();
    await writer.write(docMessage);
    writer.releaseLock();

    // Send ACK
    const ackMessage = new AckMessage(
      {
        type: "ack",
        messageId: docMessage.id,
      },
      context,
    );

    // Wait a bit for the subscription to be set up
    await new Promise((resolve) => setTimeout(resolve, 10));

    await pubSub.publish(ackTopic, ackMessage.encoded, "other-source");

    // Wait for ACK
    await trackedSink.waitForAcks();

    expect(writtenMessages).toHaveLength(1);
    expect(writtenMessages[0]).toBe(docMessage);

    await trackedSink.unsubscribe();
  });

  it("should timeout when ACK is not received", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const trackedSink = withAckTrackingSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      ackTimeout: 100, // Short timeout for testing
    });

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      context,
    );

    // Write message
    const writer = trackedSink.writable.getWriter();
    await writer.write(docMessage);
    writer.releaseLock();

    // Wait for ACK (should timeout)
    await expect(trackedSink.waitForAcks()).rejects.toThrow("ACK timeout");

    await trackedSink.unsubscribe();
  });

  it("should handle slow ACK propagation", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const trackedSink = withAckTrackingSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      ackTimeout: 1000, // Longer timeout to allow for slow propagation
    });

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      context,
    );

    // Write message
    const writer = trackedSink.writable.getWriter();
    await writer.write(docMessage);
    writer.releaseLock();

    // Wait for subscription to be set up
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate slow pubsub propagation by delaying the ACK
    const ackMessage = new AckMessage(
      {
        type: "ack",
        messageId: docMessage.id,
      },
      context,
    );

    // Wait a significant delay (simulating slow network/pubsub)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Send ACK after delay
    await pubSub.publish(ackTopic, ackMessage.encoded, "other-source");

    // Wait for ACK (should still resolve successfully despite the delay)
    await trackedSink.waitForAcks();

    expect(writtenMessages).toHaveLength(1);
    expect(writtenMessages[0]).toBe(docMessage);

    await trackedSink.unsubscribe();
  });

  it("should not track ACK messages", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const trackedSink = withAckTrackingSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      ackTimeout: 1000,
    });

    const ackMessage = new AckMessage(
      {
        type: "ack",
        messageId: "some-message-id",
      },
      context,
    );

    // Write ACK message
    const writer = trackedSink.writable.getWriter();
    await writer.write(ackMessage);
    writer.releaseLock();

    // Wait for ACKs (should resolve immediately since ACK messages aren't tracked)
    await trackedSink.waitForAcks();

    expect(writtenMessages).toHaveLength(1);
    expect(writtenMessages[0]).toBe(ackMessage);

    await trackedSink.unsubscribe();
  });

  it("should handle multiple messages and wait for all ACKs", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const trackedSink = withAckTrackingSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      ackTimeout: 1000,
    });

    const message1 = new DocMessage("test-doc", { type: "sync-done" }, context);
    const message2 = new AwarenessMessage(
      "test-doc",
      {
        type: "awareness-update",
        update: new Uint8Array([0x00, 0x01]) as AwarenessUpdateMessage,
      },
      context,
    );

    // Write messages
    const writer = trackedSink.writable.getWriter();
    await writer.write(message1);
    await writer.write(message2);
    writer.releaseLock();

    // Wait a bit for the subscription to be set up
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Send ACKs
    const ack1 = new AckMessage(
      {
        type: "ack",
        messageId: message1.id,
      },
      context,
    );
    const ack2 = new AckMessage(
      {
        type: "ack",
        messageId: message2.id,
      },
      context,
    );

    await pubSub.publish(ackTopic, ack1.encoded, "other-source");
    await pubSub.publish(ackTopic, ack2.encoded, "other-source");

    // Wait for all ACKs
    await trackedSink.waitForAcks();

    expect(writtenMessages).toHaveLength(2);
    expect(writtenMessages[0]).toBe(message1);
    expect(writtenMessages[1]).toBe(message2);

    await trackedSink.unsubscribe();
  });

  it("should handle abort signal", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const abortController = new AbortController();

    const trackedSink = withAckTrackingSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      ackTimeout: 1000,
      abortSignal: abortController.signal,
    });

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      context,
    );

    // Write message
    const writer = trackedSink.writable.getWriter();
    await writer.write(docMessage);
    writer.releaseLock();

    // Abort before ACK is received
    abortController.abort();

    // Wait for ACKs (should reject due to abort)
    await expect(trackedSink.waitForAcks()).rejects.toThrow("Request aborted");

    await trackedSink.unsubscribe();
  });

  it("should handle unsubscribe", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const trackedSink = withAckTrackingSink(baseSink, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
      ackTimeout: 1000,
    });

    const docMessage = new DocMessage(
      "test-doc",
      { type: "sync-done" },
      context,
    );

    // Write message
    const writer = trackedSink.writable.getWriter();
    await writer.write(docMessage);
    writer.releaseLock();

    // Unsubscribe before ACK is received
    await trackedSink.unsubscribe();

    // Wait for ACKs (should reject due to unsubscribe)
    await expect(trackedSink.waitForAcks()).rejects.toThrow("Unsubscribed");
  });

  it("should preserve sink properties", () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    const sinkWithProps = {
      ...baseSink,
      customProperty: "test-value",
    };

    const trackedSink = withAckTrackingSink(sinkWithProps, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
    });

    expect((trackedSink as any).customProperty).toBe("test-value");
  });

  it("should handle close", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    let closed = false;
    const sinkWithClose = {
      writable: new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
        close() {
          closed = true;
        },
      }),
    };

    const trackedSink = withAckTrackingSink(sinkWithClose, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
    });

    await trackedSink.writable.close();
    expect(closed).toBe(true);

    await trackedSink.unsubscribe();
  });

  it("should handle abort", async () => {
    const context: TestContext = {
      clientId: "test-client",
      userId: "test-user",
      room: "test-room",
    };
    const ackTopic: PubSubTopic = "ack/test-client";

    let aborted = false;
    const sinkWithAbort = {
      writable: new WritableStream({
        write(chunk) {
          writtenMessages.push(chunk);
        },
        abort(reason) {
          aborted = true;
        },
      }),
    };

    const trackedSink = withAckTrackingSink(sinkWithAbort, {
      pubSub,
      ackTopic,
      sourceId: "test-source",
    });

    await trackedSink.writable.abort("test reason");
    expect(aborted).toBe(true);

    await trackedSink.unsubscribe();
  });
});
