import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  AckMessage,
  DocMessage,
  AwarenessMessage,
  FileMessage,
  Message,
  type ClientContext,
  type StateVector,
} from "teleportal";
import { Connection, type ConnectionState } from "./connection";

// Mock Connection for testing ACK functionality
class MockConnection extends Connection<{
  connected: { clientId: string };
  disconnected: {};
  connecting: {};
  errored: { reconnectAttempt: number };
}> {
  public sentMessages: Message[] = [];
  public responseHandler?: (message: Message) => Message | null;

  constructor() {
    super({ connect: false });
    // Initialize state to disconnected
    this.setState({
      type: "disconnected",
      context: {},
    });
  }

  protected async initConnection(): Promise<void> {
    this.setState({
      type: "connecting",
      context: {},
    });
    // Simulate connection
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.setState({
      type: "connected",
      context: { clientId: "test-client" },
    });
  }

  protected async sendMessage(message: Message): Promise<void> {
    this.sentMessages.push(message);
    // If there's a response handler, simulate a response
    if (this.responseHandler) {
      const response = this.responseHandler(message);
      if (response) {
        // Emit the response asynchronously to simulate network delay
        setTimeout(() => {
          this.call("message", response);
        }, 0);
      }
    }
  }

  protected async closeConnection(): Promise<void> {
    this.setState({
      type: "disconnected",
      context: {},
    });
  }

  // Helper method to manually trigger connect
  public triggerConnect() {
    this.setState({
      type: "connected",
      context: { clientId: "test-client" },
    });
  }

  // Helper method to simulate receiving a message
  public simulateMessage(message: Message) {
    this.call("message", message);
  }
}

describe("Connection ACK and In-Flight Message Tracking", () => {
  let connection: MockConnection;

  beforeEach(() => {
    connection = new MockConnection();
  });

  afterEach(async () => {
    if (!connection.destroyed) {
      await connection.destroy();
    }
  });

  describe("In-Flight Message Tracking", () => {
    it("should track doc messages as in-flight when sent", async () => {
      await connection.connect();
      expect(connection.hasInFlightMessages).toBe(false);

      const docMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(docMessage);
      expect(connection.hasInFlightMessages).toBe(true);
      expect(connection.inFlightMessageCount).toBe(1);
    });

    it("should NOT track awareness messages as in-flight", async () => {
      await connection.connect();
      expect(connection.hasInFlightMessages).toBe(false);

      const awarenessMessage = new AwarenessMessage(
        "test-doc",
        {
          type: "awareness-update",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(awarenessMessage);
      expect(connection.hasInFlightMessages).toBe(false);
      expect(connection.inFlightMessageCount).toBe(0);
    });

    it("should NOT track ack messages as in-flight", async () => {
      await connection.connect();
      expect(connection.hasInFlightMessages).toBe(false);

      const ackMessage = new AckMessage(
        {
          type: "ack",
          messageId: "some-message-id",
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(ackMessage);
      expect(connection.hasInFlightMessages).toBe(false);
      expect(connection.inFlightMessageCount).toBe(0);
    });

    it("should track file messages as in-flight when sent", async () => {
      await connection.connect();
      expect(connection.hasInFlightMessages).toBe(false);

      const fileMessage = new FileMessage(
        "test-doc",
        {
          type: "file-download",
          fileId: "test-file-id",
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(fileMessage);
      expect(connection.hasInFlightMessages).toBe(true);
      expect(connection.inFlightMessageCount).toBe(1);
    });

    it("should remove message from in-flight when ACK is received", async () => {
      await connection.connect();

      const docMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(docMessage);
      expect(connection.hasInFlightMessages).toBe(true);
      expect(connection.inFlightMessageCount).toBe(1);

      // Simulate receiving an ACK
      const ackMessage = new AckMessage(
        {
          type: "ack",
          messageId: docMessage.id,
        },
        { clientId: "test-client" } as ClientContext,
      );

      connection.simulateMessage(ackMessage);

      // Wait a bit for the event to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connection.hasInFlightMessages).toBe(false);
      expect(connection.inFlightMessageCount).toBe(0);
    });

    it("should handle multiple in-flight messages", async () => {
      await connection.connect();

      const message1 = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" } as ClientContext,
      );

      const message2 = new DocMessage(
        "test-doc",
        {
          type: "update",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(message1);
      await connection.send(message2);

      expect(connection.hasInFlightMessages).toBe(true);
      expect(connection.inFlightMessageCount).toBe(2);

      // ACK first message
      const ack1 = new AckMessage(
        {
          type: "ack",
          messageId: message1.id,
        },
        { clientId: "test-client" } as ClientContext,
      );
      connection.simulateMessage(ack1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connection.hasInFlightMessages).toBe(true);
      expect(connection.inFlightMessageCount).toBe(1);

      // ACK second message
      const ack2 = new AckMessage(
        {
          type: "ack",
          messageId: message2.id,
        },
        { clientId: "test-client" } as ClientContext,
      );
      connection.simulateMessage(ack2);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connection.hasInFlightMessages).toBe(false);
      expect(connection.inFlightMessageCount).toBe(0);
    });

    it("should clear in-flight messages on disconnect", async () => {
      await connection.connect();

      const docMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(docMessage);
      expect(connection.hasInFlightMessages).toBe(true);

      await connection.disconnect();
      expect(connection.hasInFlightMessages).toBe(false);
    });

    it("should clear in-flight messages on destroy", async () => {
      await connection.connect();

      const docMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(docMessage);
      expect(connection.hasInFlightMessages).toBe(true);

      await connection.destroy();
      expect(connection.hasInFlightMessages).toBe(false);
    });

    it("should not track messages that fail to send", async () => {
      await connection.connect();

      const docMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" } as ClientContext,
      );

      // Make sendMessage throw by setting up the mock connection to fail
      const originalSendMessage = (connection as any).sendMessage;
      (connection as any).sendMessage = async () => {
        throw new Error("Send failed");
      };

      try {
        await connection.send(docMessage);
      } catch (error) {
        // Expected
      }

      // Wait for error handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Message should be removed from in-flight on send failure
      expect(connection.hasInFlightMessages).toBe(false);
      
      // Restore original
      (connection as any).sendMessage = originalSendMessage;
    });

    it("should ignore ACKs for messages not in-flight", async () => {
      await connection.connect();

      const ackMessage = new AckMessage(
        {
          type: "ack",
          messageId: "non-existent-message-id",
        },
        { clientId: "test-client" } as ClientContext,
      );

      // Should not throw or cause issues
      connection.simulateMessage(ackMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connection.hasInFlightMessages).toBe(false);
    });
  });
});
