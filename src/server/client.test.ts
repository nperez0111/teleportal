import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Client } from "./client";
import { DocMessage } from "teleportal";
import type { ServerContext, Message, StateVector } from "teleportal";

describe("Client", () => {
  let client: Client<ServerContext>;
  let writable: WritableStream<Message<ServerContext>>;
  let writtenMessages: Message<ServerContext>[];

  beforeEach(() => {
    writtenMessages = [];
    writable = new WritableStream({
      write(chunk) {
        writtenMessages.push(chunk);
      },
    });

    client = new Client({
      id: "test-client",
      writable,
    });
  });

  afterEach(async () => {
    // Client doesn't have a destroy method in server-v2
    // The writable stream will be closed naturally
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
      const errorWritable = new WritableStream({
        write() {
          throw new Error("Write error");
        },
      });

      const errorClient = new Client({
        id: "error-client",
        writable: errorWritable,
      });

      const mockMessage = new DocMessage(
        "test-doc",
        { type: "sync-done" },
        { clientId: "error-client", userId: "test-user", room: "test-room" },
        false,
      );

      // Client-v2 propagates errors (unlike server-v1 which handles them)
      await expect(errorClient.send(mockMessage)).rejects.toThrow(
        "Write error",
      );
    });

    it("should handle concurrent send operations safely", async () => {
      const messages = Array.from(
        { length: 10 },
        (_, i) =>
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
