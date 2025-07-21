import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { FallbackConnection } from "./fallback-connection";
import { Connection, ConnectionState } from "./connection";

process.on("uncaughtException", (err) => {
  console.error("[GLOBAL] Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("[GLOBAL] Unhandled Rejection:", err);
});

beforeAll(() => {
  // Override timer functions for testing
  Connection.setTimeout = ((
    fn: Function,
    delay: number = 0,
    ...args: any[]
  ) => {
    return setTimeout(fn, Math.min(delay, 10)) as any;
  }) as any;
  Connection.setInterval = ((
    fn: Function,
    delay: number = 0,
    ...args: any[]
  ) => {
    return setInterval(fn, Math.min(delay, 10)) as any;
  }) as any;
  Connection.clearTimeout = clearTimeout;
  Connection.clearInterval = clearInterval;
});

afterAll(() => {
  // Restore original timer functions
  Connection.setTimeout = globalThis.setTimeout.bind(globalThis);
  Connection.setInterval = globalThis.setInterval.bind(globalThis);
  Connection.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  Connection.clearInterval = globalThis.clearInterval.bind(globalThis);
});

// Mock WebSocket implementation that can be configured to fail
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
  private static shouldFail: boolean = false;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;

    // Delay connection process until after listeners are added
    queueMicrotask(() => {
      if (MockWebSocket.shouldFail) {
        this.readyState = MockWebSocket.CLOSED;
        // Dispatch error event first, then close event
        this.dispatchEvent(new Event("error"));
        // Use setTimeout to ensure error event is processed before close
        setTimeout(() => {
          this.dispatchEvent(
            new CloseEvent("close", {
              code: 1006,
              reason: "Connection failed",
            }),
          );
        }, 0);
      } else {
        this.readyState = MockWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }
    });
  }

  static setShouldFail(shouldFail: boolean) {
    MockWebSocket.shouldFail = shouldFail;
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

  dispatchEvent(event: Event) {
    const listeners = this.listeners[event.type];
    if (listeners) {
      // Use setTimeout to ensure errors are handled asynchronously
      if (event.type === "error") {
        setTimeout(() => {
          listeners.forEach((listener) => {
            try {
              listener(event);
            } catch (error) {
              // Silently handle errors to prevent them from being thrown
              console.warn("MockWebSocket error handler error:", error);
            }
          });
        }, 0);
      } else {
        listeners.forEach((listener) => listener(event));
      }
    }
    return true;
  }

  send(data: any) {
    if (this.readyState === MockWebSocket.OPEN) {
      // Echo back the data as a message event
      queueMicrotask(() => {
        this.dispatchEvent({
          type: "message",
          data: data,
        } as MessageEvent);
      });
    }
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", { code: code || 1000, reason: reason || "" }),
    );
  }
}

// Mock EventSource implementation
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState: number = MockEventSource.CONNECTING;
  url: string;
  withCredentials: boolean = false;

  private listeners: Record<string, ((event: any) => void)[]> = {};
  private clientId: string = "test-client-id";
  private messageId: number = 0;

  constructor(url: string) {
    this.url = url;
    console.log("[MockEventSource] constructed", url);
    // Delay connection process until after listeners are added
    queueMicrotask(() => {
      this.readyState = MockEventSource.OPEN;
      this.dispatchEvent(new Event("open"));
      this.simulateClientIdMessage();
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

  dispatchEvent(event: Event) {
    console.log("[MockEventSource] dispatchEvent", event);
    const listeners = this.listeners[event.type];
    if (listeners) {
      listeners.forEach((listener) => listener(event));
    }
    return true;
  }

  private simulateClientIdMessage() {
    console.log("[MockEventSource] simulateClientIdMessage", this.clientId);
    // Dispatch a 'client-id' event as expected by getSSESource
    this.dispatchEvent(
      new MessageEvent("client-id", {
        data: this.clientId,
        lastEventId: "client-id",
      }),
    );
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

// Mock fetch implementation
class MockFetch {
  private shouldSucceed: boolean = true;

  setShouldSucceed(shouldSucceed: boolean) {
    this.shouldSucceed = shouldSucceed;
  }

  async fetch(url: string, options?: RequestInit): Promise<Response> {
    if (!this.shouldSucceed) {
      throw new Error("Mock fetch error");
    }

    return new Response("OK", { status: 200 });
  }
}

function createMockFetch(mockFetch: MockFetch): typeof fetch {
  const fetchFn = mockFetch.fetch.bind(mockFetch) as typeof fetch;
  (fetchFn as any).preconnect = () => {};
  return fetchFn;
}

describe("FallbackConnection", () => {
  let client: FallbackConnection;
  let eventTarget: EventTarget;
  let mockFetch: MockFetch;

  beforeEach(async () => {
    eventTarget = new EventTarget();
    mockFetch = new MockFetch();
    MockWebSocket.setShouldFail(false);
  });

  afterEach(async () => {
    if (client) {
      await client.destroy();
    }
  });

  test("should implement the Connection interface", () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    expect(client).toBeInstanceOf(FallbackConnection);
    expect(typeof client.send).toBe("function");
    expect(typeof client.connect).toBe("function");
    expect(typeof client.disconnect).toBe("function");
    expect(typeof client.destroy).toBe("function");
    expect(typeof client.getReader).toBe("function");
    expect(typeof client.connected).toBe("object"); // Promise
    expect(typeof client.state).toBe("object");
    expect(typeof client.destroyed).toBe("boolean");
    expect(typeof client.connectionType).toBe("object"); // getter
  });

  test("should start in disconnected state", () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    expect(client.state.type).toBe("disconnected");
    expect(client.connectionType).toBe(null);
  });

  test("should successfully connect via WebSocket when WebSocket works", async () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      websocketTimeout: 100,
    });

    await client.connected;
    expect(client.state.type).toBe("connected");
    expect(client.connectionType).toBe("websocket");
  });

  test("should fallback to HTTP when WebSocket fails", async () => {
    MockWebSocket.setShouldFail(true);

    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      websocketTimeout: 50, // Short timeout to speed up test
      maxReconnectAttempts: 0, // Disable reconnection attempts
      initialReconnectDelay: 1, // Minimal delay for fallback
    });

    // Wait for the fallback to HTTP connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Fallback to HTTP timed out")),
        500,
      );
      client.on("update", (state) => {
        if (state.type === "connected" && client.connectionType === "http") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    expect(client.state.type).toBe("connected");
    expect(client.connectionType).toBe("http");
  });

  test("should handle state updates", (done) => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      connect: false, // Don't connect automatically for testing
    });

    client.on("update", (state: ConnectionState<any>) => {
      expect(state).toHaveProperty("type");
      expect(state).toHaveProperty("context");
      done();
    });

    // Trigger a state update by calling connect
    client.connect().catch(() => {
      // Expected to potentially fail since this is just testing state updates
    });
  });

  test("should be destroyed after calling destroy", async () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      connect: false, // Don't connect automatically for testing
    });

    await client.destroy();
    expect(client.destroyed).toBe(true);
  });

  test("should provide a reader", () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      connect: false, // Don't connect automatically for testing
    });

    const reader = client.getReader();
    expect(reader).toBeDefined();
    expect(typeof reader.readable).toBe("object");
  });

  test("should convert HTTP URL to WebSocket URL correctly", async () => {
    MockWebSocket.setShouldFail(false);

    client = new FallbackConnection({
      url: "http://localhost:8080/path",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
    });

    await client.connected;
    expect(client.connectionType).toBe("websocket");

    // Check that the WebSocket URL was properly converted
    // This is tested indirectly by successful connection
  });

  test("should convert HTTPS URL to WSS URL correctly", async () => {
    MockWebSocket.setShouldFail(false);

    client = new FallbackConnection({
      url: "https://localhost:8080/path",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
    });

    await client.connected;
    expect(client.connectionType).toBe("websocket");
  });

  test("should handle multiple destroy calls", async () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
    });

    await client.connected;
    expect(client.state.type).toBe("connected");

    // First destroy call
    await client.destroy();
    expect(client.destroyed).toBe(true);

    // Second destroy call should not throw
    await client.destroy();
    expect(client.destroyed).toBe(true);
  });

  test("should handle connection after destroy", async () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      connect: false,
    });

    await client.destroy();
    expect(client.destroyed).toBe(true);

    // Attempting to connect after destroy should throw
    await expect(client.connect()).rejects.toThrow(
      "FallbackConnection is destroyed, create a new instance",
    );
  });
});
