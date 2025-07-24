import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { HttpConnection } from "./connection";
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

// Mock EventSource implementation
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState: number = MockEventSource.CONNECTING;
  url: string;
  withCredentials: boolean = false;

  private listeners: Record<string, ((event: any) => void)[]> = {};
  private shouldConnect: boolean = true;
  private shouldError: boolean = false;
  private closeAfterConnect: boolean = false;
  private clientId: string = "test-client-id";
  private messageId: number = 0;

  constructor(url: string) {
    this.url = url;
    // Delay connection process until after listeners are added
    queueMicrotask(() => {
      if (this.shouldError) {
        this.readyState = MockEventSource.CLOSED;
        this.dispatchEvent(new Event("error"));
      } else if (this.shouldConnect) {
        this.readyState = MockEventSource.OPEN;
        this.dispatchEvent(new Event("open"));

        // Send initial client ID message in the correct SSE format
        this.simulateClientIdMessage();

        if (this.closeAfterConnect) {
          this.close();
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

  close() {
    if (this.readyState === MockEventSource.CLOSED) return;
    this.readyState = MockEventSource.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  // Test control methods
  setShouldConnect(shouldConnect: boolean) {
    this.shouldConnect = shouldConnect;
  }

  setShouldError(shouldError: boolean) {
    this.shouldError = shouldError;
  }

  setCloseAfterConnect(closeAfterConnect: boolean) {
    this.closeAfterConnect = closeAfterConnect;
  }

  setClientId(clientId: string) {
    this.clientId = clientId;
  }

  simulateMessage(data: string) {
    if (this.readyState === MockEventSource.OPEN) {
      this.messageId++;
      const messageEvent = new MessageEvent("message", {
        data,
        lastEventId: `event-${this.messageId}`,
      });
      this.dispatchEvent(messageEvent);
    }
  }

  simulateClientIdMessage() {
    if (this.readyState === MockEventSource.OPEN) {
      // Send client-id event in the correct SSE format
      const event = new MessageEvent("client-id", {
        data: this.clientId,
        lastEventId: "client-id",
      });
      this.dispatchEvent(event);
    }
  }

  simulatePing() {
    if (this.readyState === MockEventSource.OPEN) {
      // Send ping event in the correct SSE format
      const event = new MessageEvent("ping", {
        data: "ping",
        lastEventId: "ping",
      });
      this.dispatchEvent(event);
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
  set onclose(value: ((event: Event) => void) | null) {
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

// Mock fetch implementation
class MockFetch {
  private shouldSucceed: boolean = true;
  private responseStatus: number = 200;
  private responseData: any = { success: true };

  setShouldSucceed(shouldSucceed: boolean) {
    this.shouldSucceed = shouldSucceed;
  }

  setResponseStatus(status: number) {
    this.responseStatus = status;
  }

  setResponseData(data: any) {
    this.responseData = data;
  }

  async fetch(url: string, options?: RequestInit): Promise<Response> {
    if (!this.shouldSucceed) {
      throw new Error("Network error");
    }

    return {
      ok: this.responseStatus >= 200 && this.responseStatus < 300,
      status: this.responseStatus,
      statusText: this.responseStatus === 200 ? "OK" : "Error",
      headers: new Headers(),
      body: null,
      bodyUsed: false,
      type: "default",
      url: url,
      redirected: false,
      clone: function () {
        return this;
      },
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
      formData: async () => new FormData(),
      json: async () => this.responseData,
      text: async () => JSON.stringify(this.responseData),
    } as Response;
  }
}

// Create a mock fetch function with preconnect property
function createMockFetch(mockFetch: MockFetch): typeof fetch {
  const fetchFn = mockFetch.fetch.bind(mockFetch) as typeof fetch;
  (fetchFn as any).preconnect = () => {};
  return fetchFn;
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

describe("HttpConnection", () => {
  let client: HttpConnection;
  let eventTarget: EventTarget;
  let mockEventSource: MockEventSource;
  let mockFetch: MockFetch;

  beforeEach(async () => {
    eventTarget = new EventTarget();
    mockEventSource = new MockEventSource("http://localhost:8080/sse");
    mockFetch = new MockFetch();
  });

  afterEach(async () => {
    if (client) {
      await client.destroy();
    }
  });

  test("should implement the Connection interface", () => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      connect: false, // Don't connect automatically for testing
    });

    expect(client).toBeInstanceOf(HttpConnection);
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
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      connect: false, // Don't connect automatically for testing
    });

    expect(client.state.type).toBe("disconnected");
    if (client.state.type === "disconnected") {
      expect(client.state.context.clientId).toBe(null);
      expect(client.state.context.lastEventId).toBe(null);
    }
  });

  test("should have correct initial destroyed state", () => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      connect: false, // Don't connect automatically for testing
    });

    expect(client.destroyed).toBe(false);
  });

  test("should be destroyed after calling destroy", async () => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      connect: false, // Don't connect automatically for testing
    });

    await client.destroy();
    expect(client.destroyed).toBe(true);
  });

  test("should have a readable state", () => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      connect: false, // Don't connect automatically for testing
    });

    const state = client.state;
    expect(state).toHaveProperty("type");
    expect(state).toHaveProperty("context");
  });

  test("should provide a reader", () => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      connect: false, // Don't connect automatically for testing
    });

    const reader = client.getReader();
    expect(reader).toBeDefined();
    expect(typeof reader.readable).toBe("object");
  });

  test("should handle state updates", (done) => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
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
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
    });

    await client.connected;
    expect(client.state.type).toBe("connected");
    if (client.state.type === "connected") {
      expect(client.state.context.clientId).toBe("test-client-id");
      expect(client.state.context.lastEventId).toBe("client-id");
    }
  });

  // TODO hard to test this, need to mock the server to close the connection
  // test("should handle server closing connection and reconnect", async () => {
  //   // Create a mock EventSource that closes after connecting
  //   let connectionCount = 0;
  //   function ReconnectingEventSource(url: string) {
  //     const es = new MockEventSource(url);
  //     connectionCount++;
  //     if (connectionCount === 1) {
  //       // First connection closes immediately
  //       es.setCloseAfterConnect(true);
  //     }
  //     return es;
  //   }

  //   client = new HttpConnection({
  //     url: "http://localhost:8080",
  //     fetch: createMockFetch(mockFetch),
  //     EventSource: ReconnectingEventSource as any,
  //     initialReconnectDelay: 1, // Use a very short delay for testing
  //   });

  //   // Wait for the first connection to be established
  //   await client.connected;
  //   expect(connectionCount).toBe(1);

  //   // Wait a bit for the reconnection to happen
  //   await new Promise((resolve) => setTimeout(resolve, 50));

  //   // Check that at least one reconnection attempt was made
  //   expect(connectionCount).toBeGreaterThan(1);
  // });

  test("should handle connection errors gracefully", async () => {
    mockEventSource.setShouldError(true);

    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      maxReconnectAttempts: 1,
      initialReconnectDelay: 1,
    });

    // Test that the connection can be destroyed even when there are errors
    try {
      await client.connected;
    } catch (error) {
      // Expected to fail due to mock error
    }

    await client.destroy();
    expect(client.destroyed).toBe(true);
  });

  test("should handle fetch errors", async () => {
    mockFetch.setShouldSucceed(false);

    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      maxReconnectAttempts: 1,
      initialReconnectDelay: 1,
    });

    // Test that the connection can be destroyed even when there are fetch errors
    try {
      await client.connected;
    } catch (error) {
      // Expected to fail due to fetch error
    }

    await client.destroy();
    expect(client.destroyed).toBe(true);
  });

  test("should handle offline/online events", async () => {
    // Set location to enable offline detection
    Connection.location = { hostname: "example.com" };
    eventTarget = new EventTarget();

    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
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

  test("disconnect should close the connection and not reconnect", async () => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      initialReconnectDelay: 10,
    });

    await client.connected;
    expect(client.state.type).toBe("connected");

    client.disconnect();

    // Give a small delay for the disconnect to take effect
    await new Promise((r) => setTimeout(r, 5));

    expect(client.state.type).toBe("disconnected");
  });

  test("should handle URL ending in slash", async () => {
    client = new HttpConnection({
      url: "http://localhost:8080/",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
    });

    await client.connected;
    expect(client.state.type).toBe("connected");
  });

  test("should handle multiple destroy calls", async () => {
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
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
    client = new HttpConnection({
      url: "http://localhost:8080",
      fetch: createMockFetch(mockFetch),
      EventSource: MockEventSource as any,
      connect: false,
    });

    await client.destroy();
    expect(client.destroyed).toBe(true);

    // Attempting to connect after destroy should throw
    await expect(client.connect()).rejects.toThrow(
      "Connection is destroyed, create a new instance",
    );
  });
});
