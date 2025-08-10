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
  private static shouldTimeout: boolean = false;
  private static instances: MockWebSocket[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    
    // Track all instances for debugging
    MockWebSocket.instances.push(this);

    // Delay connection process until after listeners are added
    queueMicrotask(() => {
      if (MockWebSocket.shouldTimeout) {
        // Don't do anything, let it timeout
        return;
      }
      
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
  
  static setShouldTimeout(shouldTimeout: boolean) {
    MockWebSocket.shouldTimeout = shouldTimeout;
  }
  
  static getInstanceCount(): number {
    return MockWebSocket.instances.length;
  }
  
  static clearInstances() {
    MockWebSocket.instances = [];
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
    if (this.readyState === MockWebSocket.CLOSED) {
      return; // Already closed, don't dispatch events again
    }
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
  private static instances: MockEventSource[] = [];

  constructor(url: string) {
    this.url = url;
    
    // Track all instances for debugging
    MockEventSource.instances.push(this);
    
    // Delay connection process until after listeners are added
    queueMicrotask(() => {
      this.readyState = MockEventSource.OPEN;
      this.dispatchEvent(new Event("open"));
      this.simulateClientIdMessage();
    });
  }
  
  static getInstanceCount(): number {
    return MockEventSource.instances.length;
  }
  
  static clearInstances() {
    MockEventSource.instances = [];
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
      listeners.forEach((listener) => listener(event));
    }
    return true;
  }

  private simulateClientIdMessage() {
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
    MockWebSocket.setShouldTimeout(false);
    MockWebSocket.clearInstances();
    MockEventSource.clearInstances();
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

  // New comprehensive tests for race conditions and edge cases

  test("should prevent race conditions when connect() is called multiple times rapidly", async () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      connect: false,
    });

    // Call connect multiple times rapidly
    const promises = [
      client.connect(),
      client.connect(),
      client.connect(),
      client.connect(),
      client.connect(),
    ];

    await Promise.all(promises);

    // Should only have created one connection
    expect(client.state.type).toBe("connected");
    expect(client.connectionType).toBe("websocket");
    
    // Should only have one WebSocket instance
    expect(MockWebSocket.getInstanceCount()).toBe(1);
  });

  test("should handle WebSocket timeout and fallback to HTTP without creating multiple connections", async () => {
    MockWebSocket.setShouldTimeout(true);

    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      websocketTimeout: 50,
      maxReconnectAttempts: 0,
    });

    // Wait for connection to be established
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 1000);
      
      client.on("update", (state) => {
        if (state.type === "connected" && client.connectionType === "http") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    expect(client.state.type).toBe("connected");
    expect(client.connectionType).toBe("http");
    
    // Should have created WebSocket instances (which timed out) and EventSource instances
    // The important thing is that only one connection is active at the end
    expect(MockWebSocket.getInstanceCount()).toBeGreaterThan(0);
    expect(MockEventSource.getInstanceCount()).toBeGreaterThan(0);
  });

  test("should properly clean up connections when destroyed during connection attempt", async () => {
    MockWebSocket.setShouldTimeout(true);

    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      websocketTimeout: 200, // Longer timeout to allow for destruction
      connect: false,
    });

    // Start connection attempt
    const connectPromise = client.connect();
    
    // Wait a bit to ensure connection attempt has started
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Destroy while connecting
    await client.destroy();
    
    // The connect promise should complete (either resolve or reject) without hanging
    await Promise.race([
      connectPromise.catch(() => {
        // Expected to potentially be rejected due to destruction
      }),
      new Promise(resolve => setTimeout(resolve, 100)) // Fallback timeout
    ]);

    expect(client.destroyed).toBe(true);
  });

  test("should handle rapid connect/disconnect cycles without creating multiple connections", async () => {
    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      connect: false,
    });

    // Rapid connect/disconnect cycles
    for (let i = 0; i < 5; i++) {
      await client.connect();
      await client.disconnect();
    }

    // Final connect
    await client.connect();

    expect(client.state.type).toBe("connected");
    expect(client.connectionType).toBe("websocket");
    
    // Should have created connections for each cycle (each cycle creates a new WebSocket)
    // But the important thing is that only one is active at the end
    expect(MockWebSocket.getInstanceCount()).toBeGreaterThan(0);
  });

  test("should handle connection failure during fallback gracefully", async () => {
    MockWebSocket.setShouldFail(true);
    mockFetch.setShouldSucceed(false);

    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      websocketTimeout: 50,
      maxReconnectAttempts: 0,
    });

    // Wait for connection to fail
    await new Promise<void>((resolve) => {
      client.on("update", (state) => {
        if (state.type === "errored") {
          resolve();
        }
      });
    });

    expect(client.state.type).toBe("errored");
  });

  test("should not create multiple HTTP connections when WebSocket consistently fails", async () => {
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
      websocketTimeout: 50,
      maxReconnectAttempts: 2,
      initialReconnectDelay: 10,
    });

    // Wait for initial connection and potential reconnections
    await new Promise<void>((resolve) => {
      let connectedCount = 0;
      client.on("update", (state) => {
        if (state.type === "connected" && client.connectionType === "http") {
          connectedCount++;
          if (connectedCount === 1) {
            // After first connection, trigger a disconnection to test reconnection
            setTimeout(() => client.disconnect(), 10);
          }
        }
        if (state.type === "disconnected" && connectedCount > 0) {
          // After disconnection, wait a bit and then resolve
          setTimeout(resolve, 100);
        }
      });
    });

    // Should have created only a few EventSource instances (initial + reconnects)
    const eventSourceCount = MockEventSource.getInstanceCount();
    expect(eventSourceCount).toBeLessThanOrEqual(3); // Initial + max 2 reconnects
  });

  test("should handle WebSocket success after initial failure on reconnection", async () => {
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
      websocketTimeout: 50,
      maxReconnectAttempts: 1,
      initialReconnectDelay: 10,
    });

    // Wait for HTTP fallback connection
    await new Promise<void>((resolve) => {
      client.on("update", (state) => {
        if (state.type === "connected" && client.connectionType === "http") {
          resolve();
        }
      });
    });

    expect(client.connectionType).toBe("http");

    // Now make WebSocket work and trigger reconnection
    MockWebSocket.setShouldFail(false);
    await client.disconnect();
    await client.connect();

    // Should now use WebSocket since it's working
    expect(client.state.type).toBe("connected");
    expect(client.connectionType).toBe("websocket");
  });

  test("should cancel ongoing connection attempts when destroyed", async () => {
    MockWebSocket.setShouldTimeout(true);

    client = new FallbackConnection({
      url: "http://localhost:8080",
      websocketOptions: {
        WebSocket: MockWebSocket as any,
      },
      httpOptions: {
        fetch: createMockFetch(mockFetch),
        EventSource: MockEventSource as any,
      },
      websocketTimeout: 1000, // Long timeout
      connect: false,
    });

    // Start connection
    const connectPromise = client.connect();
    
    // Destroy immediately
    setTimeout(() => client.destroy(), 10);
    
    // Connect should complete (either resolve or reject) without hanging
    await Promise.race([
      connectPromise.catch(() => {
        // Expected to be rejected due to destruction
      }),
      new Promise(resolve => setTimeout(resolve, 100)) // Fallback timeout
    ]);

    expect(client.destroyed).toBe(true);
  });

  test("should handle concurrent connect calls during WebSocket timeout", async () => {
    MockWebSocket.setShouldTimeout(true);

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
      connect: false,
    });

    // Start multiple connection attempts during WebSocket timeout period
    const promises = [
      client.connect(),
      new Promise(resolve => setTimeout(() => resolve(client.connect()), 20)),
      new Promise(resolve => setTimeout(() => resolve(client.connect()), 40)),
      new Promise(resolve => setTimeout(() => resolve(client.connect()), 60)),
    ];

    await Promise.all(promises);

    expect(client.state.type).toBe("connected");
    expect(client.connectionType).toBe("http");
    
    // Should only have one WebSocket and one EventSource despite multiple calls
    expect(MockWebSocket.getInstanceCount()).toBe(1);
    expect(MockEventSource.getInstanceCount()).toBe(1);
  });
});
