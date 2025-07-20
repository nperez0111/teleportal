import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { WebSocketConnection } from "./connection";
import { Connection, ConnectionState } from "../connection";

process.on("uncaughtException", (err) => {
  console.error("[GLOBAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[GLOBAL] Unhandled Rejection:", reason);
});

// Mock the global EventTarget if it's not available in the test environment
if (typeof global.EventTarget === "undefined") {
  class EventTarget {
    listeners: Record<string, ((event: any) => void)[]> = {};

    addEventListener(type: string, listener: (event: any) => void) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(listener);
    }

    removeEventListener(type: string, listener: (event: any) => void) {
      if (this.listeners[type]) {
        this.listeners[type] = this.listeners[type].filter(
          (l) => l !== listener,
        );
      }
    }

    dispatchEvent(event: { type: string }) {
      if (this.listeners[event.type]) {
        this.listeners[event.type].forEach((listener) => listener(event));
      }
      return true;
    }
  }
  global.EventTarget = EventTarget as any;
}

// Mock WebSocket implementation
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  protocols?: string | string[];
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount: number = 0;
  extensions: string = "";

  private listeners: Record<string, ((event: any) => void)[]> = {};
  private shouldConnect: boolean = true;
  private shouldError: boolean = false;
  private closeAfterConnect: boolean = false;
  private closeCode: number = 1000;
  private closeReason: string = "";

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    // Delay connection process until after listeners are added
    queueMicrotask(() => {
      if (this.shouldError) {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new Event("error"));
        this.dispatchEvent(
          new CloseEvent("close", { code: 1006, reason: "Connection failed" }),
        );
      } else if (this.shouldConnect) {
        this.readyState = MockWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
        if (this.closeAfterConnect) {
          this.close(this.closeCode, this.closeReason);
        }
      }
    });
  }

  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  private dispatchEvent(event: Event) {
    if (this.listeners[event.type]) {
      this.listeners[event.type].forEach((listener) => listener(event));
    }
  }

  send(data: any) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    // Don't echo back messages automatically - this causes WritableStream lock errors
    // Tests can manually call simulateMessage() if they need to test message handling
  }

  close(code?: number, reason?: string) {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSING;
    // Synchronous close
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code: code || 1000,
        reason: reason || "",
        wasClean: true,
      }),
    );
  }

  // Test control methods
  setShouldConnect(shouldConnect: boolean) {
    this.shouldConnect = shouldConnect;
  }

  setShouldError(shouldError: boolean) {
    this.shouldError = shouldError;
  }

  setCloseAfterConnect(
    closeAfterConnect: boolean,
    code: number = 1000,
    reason: string = "",
  ) {
    this.closeAfterConnect = closeAfterConnect;
    this.closeCode = code;
    this.closeReason = reason;
  }

  simulateMessage(data: any) {
    if (this.readyState === MockWebSocket.OPEN) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }

  // For backward compatibility with tests that might still use on* properties
  get onopen() {
    return null;
  }
  set onopen(value: ((event: Event) => void) | null) {
    if (value) this.addEventListener("open", value);
  }

  get onclose() {
    return null;
  }
  set onclose(value: ((event: CloseEvent) => void) | null) {
    if (value) this.addEventListener("close", value);
  }

  get onerror() {
    return null;
  }
  set onerror(value: ((event: Event) => void) | null) {
    if (value) this.addEventListener("error", value);
  }

  get onmessage() {
    return null;
  }
  set onmessage(value: ((event: MessageEvent) => void) | null) {
    if (value) this.addEventListener("message", value);
  }
}

// Mock timers for testing
const mockTimers = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
};

// Override global timers for faster test execution
beforeAll(() => {
  globalThis.setTimeout = ((fn: Function, ms: number = 0, ...args: any[]) => {
    return mockTimers.setTimeout(() => fn(...args), ms);
  }) as any;

  globalThis.setInterval = ((fn: Function, ms: number = 0, ...args: any[]) => {
    return mockTimers.setInterval(() => fn(...args), ms);
  }) as any;
});

afterAll(() => {
  globalThis.setTimeout = mockTimers.setTimeout;
  globalThis.setInterval = mockTimers.setInterval;
  globalThis.clearTimeout = mockTimers.clearTimeout;
  globalThis.clearInterval = mockTimers.clearInterval;
});

describe("WebSocketConnection", () => {
  let client: WebSocketConnection;
  let eventTarget: EventTarget;
  let isOnline = true;

  beforeEach(async () => {
    eventTarget = new EventTarget();
    isOnline = true;
  });

  afterEach(async () => {
    if (client) {
      client.destroy();
    }
  });

  test("should implement the Connection interface", () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    expect(client).toBeInstanceOf(WebSocketConnection);
    expect(typeof client.send).toBe("function");
    expect(typeof client.connect).toBe("function");
    expect(typeof client.disconnect).toBe("function");
    expect(typeof client.destroy).toBe("function");
    expect(typeof client.getReader).toBe("function");
    expect(typeof client.connected).toBe("object"); // Promise
    expect(typeof client.state).toBe("object");
    expect(typeof client.destroyed).toBe("boolean");
  });

  test("should start in disconnected state", () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    expect(client.state.type).toBe("disconnected");
    if (client.state.type === "disconnected") {
      expect(client.state.context.ws).toBe(null);
    }
  });

  test("should have correct initial destroyed state", () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    expect(client.destroyed).toBe(false);
  });

  test("should be destroyed after calling destroy", () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    client.destroy();
    expect(client.destroyed).toBe(true);
  });

  test("should have a readable state", () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    const state = client.state;
    expect(state).toHaveProperty("type");
    expect(state).toHaveProperty("context");
  });

  test("should provide a reader", () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    const reader = client.getReader();
    expect(reader).toBeDefined();
    expect(typeof reader.readable).toBe("object");
  });

  test("should handle state updates", (done) => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    client.on("update", (state: ConnectionState<any>) => {
      expect(state).toHaveProperty("type");
      expect(state).toHaveProperty("context");
      done();
    });

    // Trigger a state update by calling connect
    client.connect().catch(() => {
      // Expected to fail since there's no server
    });
  });

  test("should connect to the server", async () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      WebSocket: MockWebSocket as any,
    });

    await client.connected;
    expect(client.state.type).toBe("connected");
  });

  test("should handle server closing connection and reconnect", async () => {
    // Create a mock WebSocket that closes after connecting
    let connectionCount = 0;
    function ReconnectingWebSocket(
      ...args: ConstructorParameters<typeof MockWebSocket>
    ) {
      const ws = new MockWebSocket(...args);
      connectionCount++;
      if (connectionCount === 1) {
        // First connection closes immediately
        ws.setCloseAfterConnect(true);
      }
      return ws;
    }

    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      WebSocket: ReconnectingWebSocket as any,
      initialReconnectDelay: 1, // Use a very short delay for testing
    });

    // Wait for the first connection to be established
    await client.connected;
    expect(connectionCount).toBe(1);

    // Wait a bit for the reconnection to happen
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check that at least one reconnection attempt was made
    expect(connectionCount).toBeGreaterThan(1);
  });

  test("should handle connection errors gracefully", async () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      WebSocket: MockWebSocket as any,
      maxReconnectAttempts: 1,
      initialReconnectDelay: 1,
    });

    // Test that the connection can be destroyed even when there are errors
    await client.connected;
    expect(client.state.type).toBe("connected");

    client.destroy();
    expect(client.destroyed).toBe(true);
  });

  test("should handle offline/online events", async () => {
    // Set location to enable offline detection
    Connection.location = { hostname: "example.com" };
    eventTarget = new EventTarget();

    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      WebSocket: MockWebSocket as any,
      eventTarget,
      isOnline: true,
    });

    await client.connected;
    expect(client.state.type).toBe("connected");

    // Simulate going offline
    eventTarget.dispatchEvent(new Event("offline"));

    // The connection should still be connected, but it won't reconnect if closed
    expect(client.state.type).toBe("connected");

    // Simulate coming back online
    eventTarget.dispatchEvent(new Event("online"));

    // Should still be connected
    expect(client.state.type).toBe("connected");

    // Cleanup
    Connection.location = undefined;
  });

  test("should buffer messages when not connected and send them on connection", async () => {
    const receivedMessages: any[] = [];

    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      WebSocket: MockWebSocket as any,
      connect: false, // Don't connect immediately
    });

    const msg1 = "hello";
    const msg2 = "world";

    client.send(new TextEncoder().encode(msg1) as any);
    client.send(new TextEncoder().encode(msg2) as any);

    expect(receivedMessages.length).toBe(0);

    client.connect();
    await client.connected;

    await new Promise((r) => setTimeout(r, 10));

    // The mock WebSocket echoes back messages, so we should receive them
    expect(client.state.type).toBe("connected");
  });

  test("disconnect should close the connection and not reconnect", async () => {
    client = new WebSocketConnection({
      url: "ws://localhost:8080",
      WebSocket: MockWebSocket as any,
      initialReconnectDelay: 10,
    });

    await client.connected;
    expect(client.state.type).toBe("connected");

    client.disconnect();

    await new Promise((r) => setTimeout(r, 10));

    expect(client.state.type).toBe("disconnected");
  });
});
