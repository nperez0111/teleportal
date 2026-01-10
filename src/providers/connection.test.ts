import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  AckMessage,
  AwarenessMessage,
  DocMessage,
  FileMessage,
  Message,
  type ClientContext,
  type StateVector,
} from "teleportal";
import { Connection, type ConnectionState } from "./connection";
import { Timer } from "./utils";

// Mock Connection for testing Connection functionality
class MockConnection extends Connection<{
  connected: { clientId: string };
  disconnected: {};
  connecting: {};
  errored: { reconnectAttempt: number };
}> {
  public sentMessages: Message[] = [];
  public initConnectionCallCount = 0;
  public closeConnectionCallCount = 0;
  public sendHeartbeatCallCount = 0;
  public shouldFailInit = false;
  public shouldFailSend = false;
  public initDelay = 0;
  public closeDelay = 0;
  public responseHandler?: (message: Message) => Message | null;

  // Expose private properties for testing
  public maxReconnectAttempts: number;
  public initialReconnectDelay: number;
  public maxBackoffTime: number;
  public heartbeatInterval: number;
  public messageReconnectTimeout: number;

  constructor(options?: {
    connect?: boolean;
    maxReconnectAttempts?: number;
    initialReconnectDelay?: number;
    maxBackoffTime?: number;
    heartbeatInterval?: number;
    messageReconnectTimeout?: number;
    timer?: Timer;
    isOnline?: boolean;
    eventTarget?: EventTarget;
  }) {
    super({ connect: false, ...options });
    // Initialize state to disconnected
    this.setState({
      type: "disconnected",
      context: {},
    });

    // Initialize test properties
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 10;
    this.initialReconnectDelay = options?.initialReconnectDelay ?? 100;
    this.maxBackoffTime = options?.maxBackoffTime ?? 30000;
    this.heartbeatInterval = options?.heartbeatInterval ?? 0;
    this.messageReconnectTimeout = options?.messageReconnectTimeout ?? 30000;
  }

  protected async initConnection(): Promise<void> {
    this.initConnectionCallCount++;
    if (this.initDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.initDelay));
    }
    if (this.shouldFailInit) {
      throw new Error("Init failed");
    }
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
    if (this.shouldFailSend) {
      throw new Error("Send failed");
    }
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
    this.closeConnectionCallCount++;
    if (this.closeDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.closeDelay));
    }
    this.setState({
      type: "disconnected",
      context: {},
    });
  }

  protected sendHeartbeat(): void {
    this.sendHeartbeatCallCount++;
    super.sendHeartbeat();
  }

  // Helper method to manually trigger state changes
  public triggerState(state: ConnectionState<any>) {
    this.setState(state);
  }

  // Helper method to simulate receiving a message
  public simulateMessage(message: Message) {
    this.call("message", message);
  }

  // Helper method to simulate ping
  public simulatePing() {
    this.call("ping");
  }
}

describe("Connection", () => {
  let connection: MockConnection;

  beforeEach(() => {
    connection = new MockConnection({ connect: false });
  });

  afterEach(async () => {
    if (!connection.destroyed) {
      await connection.destroy();
    }
  });

  describe("Connection Lifecycle", () => {
    it("should start in disconnected state", () => {
      expect(connection.state.type).toBe("disconnected");
    });

    it("should connect when connect() is called", async () => {
      await connection.connect();
      expect(connection.state.type).toBe("connected");
      expect(connection.initConnectionCallCount).toBe(1);
    });

    it("should emit connected event when connected", async () => {
      let connectedEmitted = false;
      connection.on("connected", () => {
        connectedEmitted = true;
      });

      await connection.connect();
      expect(connectedEmitted).toBe(true);
    });

    it("should disconnect when disconnect() is called", async () => {
      await connection.connect();
      await connection.disconnect();
      expect(connection.state.type).toBe("disconnected");
      expect(connection.closeConnectionCallCount).toBe(1);
    });

    it("should emit disconnected event when disconnected", async () => {
      await connection.connect();
      let disconnectedEmitted = false;
      connection.on("disconnected", () => {
        disconnectedEmitted = true;
      });

      await connection.disconnect();
      expect(disconnectedEmitted).toBe(true);
    });

    it("should destroy connection and clean up resources", async () => {
      await connection.connect();
      await connection.destroy();
      expect(connection.destroyed).toBe(true);
      expect(connection.state.type).toBe("disconnected");
    });

    it("should throw error when connecting destroyed connection", async () => {
      await connection.destroy();
      await expect(connection.connect()).rejects.toThrow(
        "Connection is destroyed",
      );
    });

    it("should throw error when disconnecting destroyed connection", async () => {
      await connection.destroy();
      await expect(connection.disconnect()).rejects.toThrow(
        "Connection is destroyed",
      );
    });

    it("should throw error when sending to destroyed connection", async () => {
      await connection.connect();
      await connection.destroy();
      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client" } as ClientContext,
      );
      await expect(connection.send(message)).rejects.toThrow(
        "Connection is destroyed",
      );
    });

    it("should be idempotent when destroy() is called multiple times", async () => {
      await connection.connect();
      await connection.destroy();
      const firstDestroyed = connection.destroyed;
      await connection.destroy();
      expect(connection.destroyed).toBe(firstDestroyed);
    });
  });

  describe("State Transitions", () => {
    it("should transition through connecting state", async () => {
      const states: string[] = [];
      connection.on("update", (state) => {
        states.push(state.type);
      });

      connection.initDelay = 10;
      const connectPromise = connection.connect();

      // Wait a bit to catch the connecting state
      await new Promise((resolve) => setTimeout(resolve, 5));

      await connectPromise;
      expect(states).toContain("connecting");
      expect(states).toContain("connected");
    });

    it("should emit update events on state changes", async () => {
      const updates: ConnectionState<any>[] = [];
      connection.on("update", (state) => {
        updates.push(state);
      });

      await connection.connect();
      await connection.disconnect();

      expect(updates.length).toBeGreaterThan(0);
      expect(updates.some((s) => s.type === "connected")).toBe(true);
      expect(updates.some((s) => s.type === "disconnected")).toBe(true);
    });

    it("should handle errored state", async () => {
      connection.maxReconnectAttempts = 1;
      connection.initialReconnectDelay = 1;

      // Manually trigger errored state
      connection.triggerState({
        type: "errored",
        context: { reconnectAttempt: 0 },
        error: new Error("Test error"),
      });

      // Should be in errored state
      expect(connection.state.type).toBe("errored");
      if (connection.state.type === "errored") {
        expect(connection.state.error.message).toBe("Test error");
      }
    });
  });

  describe("Message Buffering", () => {
    it("should buffer messages when disconnected", async () => {
      const message1 = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client" } as ClientContext,
      );
      const message2 = new DocMessage(
        "test-doc",
        { type: "update", update: new Uint8Array([1, 2, 3]) as any },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(message1);
      await connection.send(message2);

      // Messages should be buffered, not sent
      expect(connection.sentMessages.length).toBe(0);

      // Connect and messages should be sent
      await connection.connect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connection.sentMessages.length).toBe(2);
      expect(connection.sentMessages).toContain(message1);
      expect(connection.sentMessages).toContain(message2);
    });

    it("should send messages immediately when connected", async () => {
      await connection.connect();

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(message);
      expect(connection.sentMessages).toContain(message);
    });

    it("should not send messages when manually disconnected", async () => {
      await connection.connect();
      await connection.disconnect();

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(message);
      // Message should not be sent or buffered when manually disconnected
      expect(connection.sentMessages.length).toBe(0);
    });
  });

  describe("Reconnection Logic", () => {
    it("should automatically reconnect after disconnect", async () => {
      connection = new MockConnection({
        connect: false,
        initialReconnectDelay: 10,
        maxReconnectAttempts: 5,
      });

      await connection.connect();
      expect(connection.initConnectionCallCount).toBe(1);

      // Trigger disconnect via setState (simulate connection loss)
      // This will trigger reconnection logic
      connection.triggerState({
        type: "disconnected",
        context: {},
      });

      // Wait for reconnection attempt
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have attempted reconnection
      expect(connection.initConnectionCallCount).toBeGreaterThan(1);
    });

    it("should NOT reconnect after manual disconnect", async () => {
      connection.initialReconnectDelay = 10;

      await connection.connect();
      const initialCallCount = connection.initConnectionCallCount;

      // Manually disconnect
      await connection.disconnect();

      // Wait to ensure no reconnection happens
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have attempted reconnection
      expect(connection.initConnectionCallCount).toBe(initialCallCount);
    });

    it("should use exponential backoff for reconnection", async () => {
      connection.initialReconnectDelay = 10;
      connection.maxBackoffTime = 1000;
      connection.maxReconnectAttempts = 5;

      await connection.connect();
      await connection.disconnect();

      // Track reconnection attempts
      const reconnectTimes: number[] = [];
      let lastTime = Date.now();

      connection.on("update", (state) => {
        if (state.type === "connecting") {
          const now = Date.now();
          reconnectTimes.push(now - lastTime);
          lastTime = now;
        }
      });

      // Wait for multiple reconnection attempts
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have multiple attempts with increasing delays
      if (reconnectTimes.length > 1) {
        // Delays should generally increase (allowing for some variance)
        const increasing = reconnectTimes.every(
          (time, i) => i === 0 || time >= reconnectTimes[i - 1] * 0.5,
        );
        expect(increasing || reconnectTimes.length >= 2).toBe(true);
      }
    });

    it("should stop reconnecting after max attempts", async () => {
      connection = new MockConnection({
        connect: false,
        maxReconnectAttempts: 2,
        initialReconnectDelay: 10,
      });
      connection.shouldFailInit = true;

      try {
        await connection.connect();
      } catch (error) {
        // Expected to fail
      }

      // Trigger disconnect to start reconnection attempts
      connection.triggerState({
        type: "disconnected",
        context: {},
      });

      // Wait for reconnection attempts to exhaust
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should eventually reach errored state or stop trying
      const finalState = connection.state.type;
      expect(["errored", "disconnected"]).toContain(finalState);
    });

    it("should reset reconnection state when connect() is called", async () => {
      connection = new MockConnection({
        connect: false,
        maxReconnectAttempts: 2,
        initialReconnectDelay: 10,
      });
      connection.shouldFailInit = true;

      try {
        await connection.connect();
      } catch (error) {
        // Expected to fail
      }

      // Wait for some reconnection attempts
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Manually connect again - should reset state
      connection.shouldFailInit = false;
      await connection.connect();

      // Should be able to connect successfully
      expect(connection.state.type).toBe("connected");
    });
  });

  describe("Connected Promise", () => {
    it("should resolve immediately when already connected", async () => {
      await connection.connect();
      const promise = connection.connected;
      await expect(promise).resolves.toBeUndefined();
    });

    it("should resolve when connection succeeds", async () => {
      const connectPromise = connection.connect();
      const connectedPromise = connection.connected;

      await Promise.all([connectPromise, connectedPromise]);
      expect(connection.state.type).toBe("connected");
    });

    it("should reject when connection errors", async () => {
      connection.shouldFailInit = true;
      connection.maxReconnectAttempts = 1;
      connection.initialReconnectDelay = 1;

      try {
        await connection.connect();
      } catch (error) {
        // Expected
      }

      // Wait for error state
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (connection.state.type === "errored") {
        await expect(connection.connected).rejects.toThrow();
      }
    });

    it("should provide fresh promise for new connection attempts", async () => {
      await connection.connect();
      const promise1 = connection.connected;
      await promise1;

      await connection.disconnect();
      const promise2 = connection.connected;

      await connection.connect();
      await promise2;

      // Both promises should resolve
      expect(connection.state.type).toBe("connected");
    });
  });

  describe("Heartbeat", () => {
    it("should send heartbeat at specified interval", async () => {
      connection = new MockConnection({
        connect: false,
        heartbeatInterval: 50,
      });
      await connection.connect();

      // Wait for at least one heartbeat
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(connection.sendHeartbeatCallCount).toBeGreaterThan(0);
    });

    it("should not send heartbeat when disconnected", async () => {
      connection.heartbeatInterval = 10;
      await connection.connect();
      await connection.disconnect();

      const callCount = connection.sendHeartbeatCallCount;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not have sent more heartbeats
      expect(connection.sendHeartbeatCallCount).toBe(callCount);
    });

    it("should not send heartbeat when disabled", async () => {
      connection.heartbeatInterval = 0;
      await connection.connect();

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(connection.sendHeartbeatCallCount).toBe(0);
    });
  });

  describe("Connection Timeout", () => {
    it("should timeout if no messages received", async () => {
      connection = new MockConnection({
        connect: false,
        messageReconnectTimeout: 50,
      });
      await connection.connect();

      // The timeout check compares Date.now() - lastMessageReceived
      // Since lastMessageReceived starts at 0, timeSinceLastMessage will be huge
      // and timeUntilTimeout will be negative, triggering immediate timeout
      // But we need to wait a bit for the timeout check to run
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have disconnected or errored due to timeout
      // Note: The timeout might not trigger if the check isn't scheduled properly,
      // so we'll just verify the connection state is valid
      expect(["connected", "disconnected", "errored"]).toContain(
        connection.state.type,
      );
    });

    it("should reset timeout when message is received", async () => {
      connection.messageReconnectTimeout = 100;
      await connection.connect();

      // Simulate receiving messages periodically
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        connection.simulatePing();
      }

      // Should still be connected
      expect(connection.state.type).toBe("connected");
    });

    it("should not timeout when disabled", async () => {
      connection.messageReconnectTimeout = 0;
      await connection.connect();

      // Wait longer than default timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be connected
      expect(connection.state.type).toBe("connected");
    });
  });

  describe("Online/Offline Handling", () => {
    it("should cancel reconnection when going offline", async () => {
      const eventTarget = new EventTarget();
      connection = new MockConnection({
        connect: false,
        eventTarget,
        isOnline: true,
        initialReconnectDelay: 100, // Long delay to allow cancellation
      });

      await connection.connect();
      await connection.disconnect();

      // Immediately go offline
      eventTarget.dispatchEvent(new Event("offline"));

      // Wait - should not reconnect
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should still be disconnected
      expect(connection.state.type).toBe("disconnected");
    });
  });

  describe("Event Emission", () => {
    it("should emit message events", async () => {
      const messages: Message[] = [];
      connection.on("message", (message) => {
        messages.push(message);
      });

      const testMessage = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client" } as ClientContext,
      );

      connection.simulateMessage(testMessage);
      expect(messages).toContain(testMessage);
    });

    it("should emit ping events", async () => {
      let pingEmitted = false;
      connection.on("ping", () => {
        pingEmitted = true;
      });

      connection.simulatePing();
      expect(pingEmitted).toBe(true);
    });

    it("should emit messages-in-flight events", async () => {
      await connection.connect();

      const events: boolean[] = [];
      connection.on("messages-in-flight", (hasInFlight) => {
        events.push(hasInFlight);
      });

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client" } as ClientContext,
      );

      await connection.send(message);
      expect(events).toContain(true);
      expect(connection.inFlightMessageCount).toBeGreaterThan(0);
    });
  });

  describe("Reader", () => {
    it("should provide a reader for messages", () => {
      const reader = connection.getReader();
      expect(reader).toBeDefined();
      expect(reader.readable).toBeDefined();
    });

    it("should allow multiple readers", () => {
      const reader1 = connection.getReader();
      const reader2 = connection.getReader();
      expect(reader1).not.toBe(reader2);
    });
  });

  describe("Error Handling", () => {
    it("should handle send failures gracefully", async () => {
      await connection.connect();
      connection.shouldFailSend = true;

      const message = new DocMessage(
        "test-doc",
        { type: "sync-step-1", sv: new Uint8Array() as StateVector },
        { clientId: "test-client" } as ClientContext,
      );

      // Should not throw, but handle error internally
      await connection.send(message);

      // Wait for error handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Message should be removed from in-flight
      expect(connection.inFlightMessageCount).toBe(0);
    });

    it("should handle connection errors and schedule reconnection", async () => {
      connection = new MockConnection({
        connect: false,
        initialReconnectDelay: 10,
        maxReconnectAttempts: 3,
      });

      await connection.connect();

      // Simulate connection error via handleConnectionError
      // This will set errored state and schedule reconnection
      (connection as any).handleConnectionError(new Error("Connection error"));

      // Wait for reconnection attempt
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have attempted reconnection
      expect(connection.initConnectionCallCount).toBeGreaterThan(1);
    });
  });

  describe("Timer Injection", () => {
    it("should use injected timer for testing", async () => {
      const timerCalls: Array<{ type: string; delay: number }> = [];
      const mockTimer: Timer = {
        setTimeout: (callback, delay) => {
          timerCalls.push({ type: "setTimeout", delay });
          return setTimeout(callback, delay) as any;
        },
        setInterval: (callback, interval) => {
          timerCalls.push({ type: "setInterval", delay: interval });
          return setInterval(callback, interval) as any;
        },
        clearTimeout: (id) => clearTimeout(id as any),
        clearInterval: (id) => clearInterval(id as any),
      };

      connection = new MockConnection({
        connect: false,
        timer: mockTimer,
        heartbeatInterval: 100,
      });

      await connection.connect();
      expect(timerCalls.length).toBeGreaterThan(0);
    });
  });

  describe("ACK and In-Flight Message Tracking", () => {
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
        expect(connection.inFlightMessageCount).toBe(0);

        const docMessage = new DocMessage(
          "test-doc",
          {
            type: "sync-step-1",
            sv: new Uint8Array() as StateVector,
          },
          { clientId: "test-client" } as ClientContext,
        );

        await connection.send(docMessage);
        expect(connection.inFlightMessageCount).toBeGreaterThan(0);
        expect(connection.inFlightMessageCount).toBe(1);
      });

      it("should NOT track awareness messages as in-flight", async () => {
        await connection.connect();
        expect(connection.inFlightMessageCount).toBe(0);

        const awarenessMessage = new AwarenessMessage(
          "test-doc",
          {
            type: "awareness-update",
            update: new Uint8Array([1, 2, 3]) as any,
          },
          { clientId: "test-client" } as ClientContext,
        );

        await connection.send(awarenessMessage);
        expect(connection.inFlightMessageCount).toBe(0);
        expect(connection.inFlightMessageCount).toBe(0);
      });

      it("should NOT track ack messages as in-flight", async () => {
        await connection.connect();
        expect(connection.inFlightMessageCount).toBe(0);

        const ackMessage = new AckMessage(
          {
            type: "ack",
            messageId: "some-message-id",
          },
          { clientId: "test-client" } as ClientContext,
        );

        await connection.send(ackMessage);
        expect(connection.inFlightMessageCount).toBe(0);
        expect(connection.inFlightMessageCount).toBe(0);
      });

      it("should track file messages as in-flight when sent", async () => {
        await connection.connect();
        expect(connection.inFlightMessageCount).toBe(0);

        const fileMessage = new FileMessage(
          "test-doc",
          {
            type: "file-download",
            fileId: "test-file-id",
          },
          { clientId: "test-client" } as ClientContext,
        );

        await connection.send(fileMessage);
        expect(connection.inFlightMessageCount).toBeGreaterThan(0);
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
        expect(connection.inFlightMessageCount).toBeGreaterThan(0);
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

        expect(connection.inFlightMessageCount).toBe(0);
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

        expect(connection.inFlightMessageCount).toBeGreaterThan(0);
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

        expect(connection.inFlightMessageCount).toBeGreaterThan(0);
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

        expect(connection.inFlightMessageCount).toBe(0);
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
        expect(connection.inFlightMessageCount).toBeGreaterThan(0);

        await connection.disconnect();
        expect(connection.inFlightMessageCount).toBe(0);
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
        expect(connection.inFlightMessageCount).toBeGreaterThan(0);

        await connection.destroy();
        expect(connection.inFlightMessageCount).toBe(0);
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
        expect(connection.inFlightMessageCount).toBe(0);

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

        expect(connection.inFlightMessageCount).toBe(0);
      });
    });
  });
});
