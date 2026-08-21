import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Client } from "./client";
import { AckMessage, AwarenessMessage, DocMessage } from "teleportal";
import type { AwarenessUpdateMessage, Message, ServerContext, StateVector } from "teleportal";

describe("Client", () => {
  let client: Client<ServerContext>;
  let writtenMessages: Message<ServerContext>[];

  beforeEach(() => {
    writtenMessages = [];

    client = new Client({
      id: "test-client",
      write(chunk) {
        writtenMessages.push(chunk);
      },
    });
  });

  afterEach(async () => {
    // Client doesn't have a destroy method in server-v2
  });

  describe("constructor", () => {
    it("should create a Client instance", () => {
      expect(client).toBeDefined();
      expect(client.id).toBe("test-client");
    });
  });

  describe("send", () => {
    it("should send a message successfully", async () => {
      const mockMessage = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "test-client", userId: "test-user", room: "test-room" },
        false,
      );

      await client.send(mockMessage);

      expect(writtenMessages.length).toBe(1);
      expect(writtenMessages[0]).toBe(mockMessage);
    });

    it("should send multiple messages", async () => {
      const message1 = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "test-client", userId: "test-user", room: "test-room" },
        false,
      );
      const message2 = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client", userId: "test-user", room: "test-room" },
        false,
      );

      await client.send(message1);
      await client.send(message2);

      expect(writtenMessages.length).toBe(2);
      expect(writtenMessages[0]).toBe(message1);
      expect(writtenMessages[1]).toBe(message2);
    });

    it("should propagate send errors", async () => {
      const errorClient = new Client({
        id: "error-client",
        write() {
          throw new Error("Write error");
        },
      });

      const mockMessage = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "error-client", userId: "test-user", room: "test-room" },
        false,
      );

      // Client-v2 propagates errors (unlike server-v1 which handles them)
      await expect(errorClient.send(mockMessage)).rejects.toThrow("Write error");
    });

    it("should handle concurrent send operations safely", async () => {
      const messages = Array.from(
        { length: 10 },
        (_) =>
          new DocMessage(
            "test-doc",
            { type: "sync-done" },
            { clientId: "test-client", userId: "test-user", room: "test-room" },
            false,
          ),
      );

      // Send all messages concurrently
      const sendPromises = messages.map((msg) => client.send(msg));

      // All sends should complete without error
      await Promise.all(sendPromises);

      // All messages should have been written
      expect(writtenMessages.length).toBe(10);
      expect(writtenMessages).toEqual(messages);
    });
  });
});

describe("Client delivery tracking", () => {
  const context = { clientId: "test-client", userId: "test-user", room: "test-room" };

  function syncDone() {
    return new DocMessage("test-doc", { type: "sync-done" }, { ...context }, false);
  }

  function trackingClient() {
    const written: Message<ServerContext>[] = [];
    const client = new Client<ServerContext>({
      id: "test-client",
      write(chunk) {
        written.push(chunk);
      },
    });
    return { client, written };
  }

  it("resolves onAck when the client acks the message", async () => {
    // `send` resolving only means the message reached the transport. Whether it *landed*
    // is what lets a handler clean up after itself.
    const { client, written } = trackingClient();
    const outcomes: unknown[] = [];
    const message = syncDone();

    await client.send(message, { onAck: (result) => outcomes.push(result) });
    expect(outcomes).toEqual([]);

    client.handleAck(new AckMessage({ type: "ack", messageId: written[0].id }, { ...context }));
    expect(outcomes).toEqual([{ delivered: true }]);
  });

  it("reports a NACK carrying an error as a rejection", async () => {
    const { client, written } = trackingClient();
    const outcomes: unknown[] = [];

    await client.send(syncDone(), { onAck: (result) => outcomes.push(result) });
    client.handleAck(
      new AckMessage(
        { type: "ack", messageId: written[0].id, error: "permission denied" },
        { ...context },
      ),
    );

    expect(outcomes).toEqual([
      { delivered: false, reason: "rejected", error: "permission denied" },
    ]);
  });

  it("reports disconnection for messages still in flight", async () => {
    const { client } = trackingClient();
    const outcomes: unknown[] = [];

    await client.send(syncDone(), { onAck: (result) => outcomes.push(result) });
    client.destroy();

    expect(outcomes).toEqual([{ delivered: false, reason: "disconnected" }]);
  });

  it("reports a timeout when no ack arrives", async () => {
    const { client } = trackingClient();
    const outcomes: unknown[] = [];

    await client.send(syncDone(), { onAck: (result) => outcomes.push(result), ackTimeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(outcomes).toEqual([{ delivered: false, reason: "timeout" }]);
  });

  it("settles each callback exactly once", async () => {
    // A timed-out message that acks late, or a disconnect after an ack, must not
    // double-fire — callers use this to release resources.
    const { client, written } = trackingClient();
    const outcomes: unknown[] = [];

    await client.send(syncDone(), { onAck: (result) => outcomes.push(result) });
    const ack = new AckMessage({ type: "ack", messageId: written[0].id }, { ...context });
    client.handleAck(ack);
    client.handleAck(ack);
    client.destroy();

    expect(outcomes).toEqual([{ delivered: true }]);
  });

  it("tracks nothing for a best-effort message", async () => {
    // Awareness and other `requiresAck: false` traffic is never acked, so a callback on it
    // could only ever time out. Report it immediately rather than leaving it pending.
    const { client } = trackingClient();
    const outcomes: unknown[] = [];

    await client.send(
      new AwarenessMessage(
        "test-doc",
        { type: "awareness-update", update: new Uint8Array([1]) as AwarenessUpdateMessage },
        { ...context },
        false,
      ),
      { onAck: (result) => outcomes.push(result) },
    );

    expect(outcomes).toEqual([{ delivered: false, reason: "not-acknowledged" }]);
  });

  it("does not track messages sent without a callback", async () => {
    const { client, written } = trackingClient();
    await client.send(syncDone());
    // No pending entry to settle, so an ack for it is simply ignored.
    expect(() =>
      client.handleAck(new AckMessage({ type: "ack", messageId: written[0].id }, { ...context })),
    ).not.toThrow();
  });
});
