import { describe, expect, test, mock } from "bun:test";
import {
  getHealthHandler,
  getMetricsHandler,
  getStatusHandler,
} from "./http-handlers";

// Mock server implementation
class MockServer {
  async getHealth() {
    return {
      status: "healthy",
      timestamp: "2024-01-01T00:00:00Z",
      checks: { server: "healthy", storage: "healthy" },
      uptime: 3600,
    };
  }

  async getMetrics() {
    return "# HELP test_metric A test metric\n# TYPE test_metric counter\ntest_metric 42\n";
  }

  async getStatus() {
    return {
      nodeId: "test-node",
      activeClients: 5,
      activeSessions: 3,
      pendingSessions: 1,
      totalMessagesProcessed: 100,
      uptime: 3600,
      timestamp: "2024-01-01T00:00:00Z",
    };
  }
}

describe("getHealthHandler", () => {
  test("returns health status as JSON", async () => {
    const server = new MockServer() as any;
    const handler = getHealthHandler(server);

    const request = new Request("http://localhost/health");
    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.status).toBe("healthy");
    expect(body.checks.server).toBe("healthy");
    expect(body.uptime).toBe(3600);
  });

  test("handles errors gracefully", async () => {
    const server = {
      getHealth: mock(() =>
        Promise.reject(new Error("Database connection failed")),
      ),
    };
    const handler = getHealthHandler(server as any);

    const request = new Request("http://localhost/health");
    const response = await handler(request);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.status).toBe("unhealthy");
    expect(body.error).toBe("Database connection failed");
  });
});

describe("getMetricsHandler", () => {
  test("returns metrics in Prometheus format", async () => {
    const server = new MockServer() as any;
    const handler = getMetricsHandler(server);

    const request = new Request("http://localhost/metrics");
    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );

    const body = await response.text();
    expect(body).toContain("# HELP test_metric");
    expect(body).toContain("# TYPE test_metric counter");
    expect(body).toContain("test_metric 42");
  });

  test("handles errors gracefully", async () => {
    const server = {
      getMetrics: mock(() =>
        Promise.reject(new Error("Metrics collection failed")),
      ),
    };
    const handler = getMetricsHandler(server as any);

    const request = new Request("http://localhost/metrics");
    const response = await handler(request);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe("Metrics collection failed");
  });
});

describe("getStatusHandler", () => {
  test("returns status as JSON", async () => {
    const server = new MockServer() as any;
    const handler = getStatusHandler(server);

    const request = new Request("http://localhost/status");
    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.nodeId).toBe("test-node");
    expect(body.activeClients).toBe(5);
    expect(body.activeSessions).toBe(3);
  });

  test("handles errors gracefully", async () => {
    const server = {
      getStatus: mock(() =>
        Promise.reject(new Error("Status retrieval failed")),
      ),
    };
    const handler = getStatusHandler(server as any);

    const request = new Request("http://localhost/status");
    const response = await handler(request);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Status retrieval failed");
    expect(body.message).toBe("Status retrieval failed");
  });
});
