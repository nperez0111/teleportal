import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLogger } from "@logtape/logtape";
import {
  DocMessage,
  InMemoryPubSub,
  type ServerContext,
  type StateVector,
  encodeMessageArray,
} from "teleportal";
import { DocumentStorage } from "teleportal/storage";
import { augmentLogger } from "../server/logger";
import { Server } from "../server/server";
import {
  getHTTPEndpoint,
  getSSEReaderEndpoint,
  getSSEWriterEndpoint,
} from "./handlers";
import { getDocumentsFromQueryParams } from "./utils";

// Mock DocumentStorage for testing
class MockDocumentStorage extends DocumentStorage {
  handleSyncStep1(
    key: string,
    syncStep1: StateVector,
  ): Promise<{ update: any; stateVector: StateVector }> {
    return Promise.resolve({
      update: new Uint8Array([1, 2, 3]),
      stateVector: syncStep1,
    });
  }
  handleSyncStep2(key: string, syncStep2: any): Promise<void> {
    return Promise.resolve();
  }
  public get fileStorage() {
    return undefined;
  }
  public encrypted = false;
  public storedData: any = null;
  public metadata: Map<string, any> = new Map();

  async fetch(documentId: string) {
    return this.storedData;
  }

  async write(documentId: string, update: any) {
    this.storedData = update;
  }

  async writeDocumentMetadata(key: string, metadata: any): Promise<void> {
    this.metadata.set(key, metadata);
  }

  async fetchDocumentMetadata(key: string): Promise<any> {
    return this.metadata.get(key) || {};
  }

  async deleteDocument(key: string): Promise<void> {
    this.metadata.delete(key);
    this.storedData = null;
  }
}

describe("HTTP Handlers", () => {
  let server: Server<ServerContext>;
  let mockGetStorage: any;
  let pubSub: InMemoryPubSub;
  let mockGetContext: (
    req: Request,
  ) => Promise<Omit<ServerContext, "clientId">>;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    mockGetStorage = () => Promise.resolve(new MockDocumentStorage());
    mockGetContext = async () => ({
      userId: "user-1",
      room: "room-1",
    });

      server = new Server({
        getStorage: mockGetStorage,
        pubSub,
        logger: augmentLogger(
          getLogger(["teleportal", "tests", "http-handlers"]),
        ),
      });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  describe("getSSEReaderEndpoint", () => {
    it("should create SSE reader endpoint", () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
      });
      expect(endpoint).toBeDefined();
      expect(typeof endpoint).toBe("function");
    });

    it("should return SSE response for GET request", async () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "GET",
      });

      const response = await endpoint(request);

      expect(response).toBeDefined();
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("x-powered-by")).toBe("teleportal");
    });

    it("should extract client ID from header", async () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "GET",
        headers: {
          "x-teleportal-client-id": "custom-client-id",
        },
      });

      const response = await endpoint(request);
      expect(response.headers.get("x-teleportal-client-id")).toBe(
        "custom-client-id",
      );
    });

    it("should extract client ID from query parameter", async () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request(
        "http://example.com/sse?client-id=query-client-id",
        {
          method: "GET",
        },
      );

      const response = await endpoint(request);
      expect(response.headers.get("x-teleportal-client-id")).toBe(
        "query-client-id",
      );
    });

    it("should generate client ID when not provided", async () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "GET",
      });

      const response = await endpoint(request);
      const clientId = response.headers.get("x-teleportal-client-id");
      expect(clientId).toBeDefined();
      expect(clientId?.length).toBeGreaterThan(0);
    });

    it("should subscribe to initial documents", async () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
        getInitialDocuments: getDocumentsFromQueryParams,
      });

      const request = new Request(
        "http://example.com/sse?documents=doc-1&documents=doc-2",
        {
          method: "GET",
        },
      );

      const response = await endpoint(request);
      expect(response.status).toBe(200);

      // Wait a bit for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify sessions were created
      const session1 = await server.getOrOpenSession("doc-1", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      const session2 = await server.getOrOpenSession("doc-2", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      expect(session1).toBeDefined();
      expect(session2).toBeDefined();
    });

    it("should handle encrypted documents", async () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
        getInitialDocuments: getDocumentsFromQueryParams,
      });

      const request = new Request(
        "http://example.com/sse?documents=doc-1:encrypted",
        {
          method: "GET",
        },
      );

      const response = await endpoint(request);
      expect(response.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const session = await server.getOrOpenSession("doc-1", {
        encrypted: true,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      expect(session).toBeDefined();
      expect(session.encrypted).toBe(true);
    });

    it("should handle abort signal", async () => {
      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
      });

      const controller = new AbortController();
      const request = new Request("http://example.com/sse", {
        method: "GET",
        signal: controller.signal,
      });

      const responsePromise = endpoint(request);

      // Abort the request
      controller.abort();

      const response = await responsePromise;
      expect(response.status).toBe(200);
    });

    it("should use custom getInitialDocuments", async () => {
      const customGetInitialDocuments = () => [
        { document: "custom-doc", encrypted: true },
      ];

      const endpoint = getSSEReaderEndpoint({
        server,
        getContext: mockGetContext,
        getInitialDocuments: customGetInitialDocuments,
      });

      const request = new Request("http://example.com/sse", {
        method: "GET",
      });

      const response = await endpoint(request);
      expect(response.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const session = await server.getOrOpenSession("custom-doc", {
        encrypted: true,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      expect(session).toBeDefined();
    });
  });

  describe("getSSEWriterEndpoint", () => {
    it("should create SSE writer endpoint", () => {
      const endpoint = getSSEWriterEndpoint({
        server,
        getContext: mockGetContext,
      });
      expect(endpoint).toBeDefined();
      expect(typeof endpoint).toBe("function");
    });

    it("should return 400 when no client ID provided", async () => {
      const endpoint = getSSEWriterEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "POST",
      });

      const response = await endpoint(request);

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("No client ID provided");
    });

    it("should accept client ID from header", async () => {
      const endpoint = getSSEWriterEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "POST",
        headers: {
          "x-teleportal-client-id": "client-123",
        },
        body: new Uint8Array(),
      });

      const response = await endpoint(request);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.message).toBe("ok");
      expect(response.headers.get("x-teleportal-client-id")).toBe("client-123");
    });

    it("should accept client ID from query parameter", async () => {
      const endpoint = getSSEWriterEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request(
        "http://example.com/sse?client-id=client-456",
        {
          method: "POST",
          body: new Uint8Array(),
        },
      );

      const response = await endpoint(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("x-teleportal-client-id")).toBe("client-456");
    });

    it("should handle abort signal", async () => {
      const endpoint = getSSEWriterEndpoint({
        server,
        getContext: mockGetContext,
      });

      const controller = new AbortController();
      const request = new Request("http://example.com/sse", {
        method: "POST",
        headers: {
          "x-teleportal-client-id": "client-123",
        },
        body: new Uint8Array(),
        signal: controller.signal,
      });

      const responsePromise = endpoint(request);

      // Abort the request
      controller.abort();

      // Should still return 200 (abort is handled internally)
      const response = await responsePromise;
      expect(response.status).toBe(200);
    });

    it("should return response with correct headers", async () => {
      const endpoint = getSSEWriterEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "POST",
        headers: {
          "x-teleportal-client-id": "client-123",
        },
        body: new Uint8Array(),
      });

      const response = await endpoint(request);

      expect(response.headers.get("x-powered-by")).toBe("teleportal");
      expect(response.headers.get("x-teleportal-client-id")).toBe("client-123");
    });
  });

  describe("getHTTPEndpoint", () => {
    it("should create HTTP endpoint", () => {
      const endpoint = getHTTPEndpoint({
        server,
        getContext: mockGetContext,
      });
      expect(endpoint).toBeDefined();
      expect(typeof endpoint).toBe("function");
    });

    it("should return binary stream response", async () => {
      const endpoint = getHTTPEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/message", {
        method: "POST",
        body: new Uint8Array(),
      });

      const response = await endpoint(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("x-powered-by")).toBe("teleportal");
      expect(response.headers.get("x-teleportal-client-id")).toBeDefined();
    });

    it("should generate client ID", async () => {
      const endpoint = getHTTPEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/message", {
        method: "POST",
        body: new Uint8Array(),
      });

      const response = await endpoint(request);

      const clientId = response.headers.get("x-teleportal-client-id");
      expect(clientId).toBeDefined();
      expect(clientId?.length).toBeGreaterThan(0);
    });

    it("should handle abort signal", async () => {
      const endpoint = getHTTPEndpoint({
        server,
        getContext: mockGetContext,
      });

      const controller = new AbortController();
      const request = new Request("http://example.com/message", {
        method: "POST",
        body: new Uint8Array(),
        signal: controller.signal,
      });

      const responsePromise = endpoint(request);

      // Abort the request
      controller.abort();

      const response = await responsePromise;
      expect(response.status).toBe(200);
    });

    it("should return readable stream", async () => {
      const endpoint = getHTTPEndpoint({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/message", {
        method: "POST",
        body: new Uint8Array(),
      });

      const response = await endpoint(request);

      expect(response.body).toBeDefined();
      expect(response.body).toBeInstanceOf(ReadableStream);
    });

    it("should use context from getContext", async () => {
      let capturedContext: any = null;
      const customGetContext = async (req: Request) => {
        const ctx = {
          userId: "custom-user",
          room: "custom-room",
        };
        capturedContext = ctx;
        return ctx;
      };

      const endpoint = getHTTPEndpoint({
        server,
        getContext: customGetContext,
      });

      const request = new Request("http://example.com/message", {
        method: "POST",
        body: new Uint8Array(),
      });

      await endpoint(request);

      expect(capturedContext).toBeDefined();
      expect(capturedContext.userId).toBe("custom-user");
      expect(capturedContext.room).toBe("custom-room");
    });
  });

  describe("ACK logic", () => {
    describe("getSSEWriterEndpoint", () => {
      // Note: The ACK transport wrappers (withAckSink and withAckTrackingSink) are
      // thoroughly tested in src/transports/ack/ack.test.ts. These tests focus on
      // integration-level behavior in the HTTP handlers.

      it("should return 504 when ACK timeout occurs", async () => {
        const clientId = "test-client-timeout";
        const writerEndpoint = getSSEWriterEndpoint({
          server,
          getContext: mockGetContext,
          ackTimeout: 100, // Use a short timeout for testing
        });

        // Don't set up a reader, so no ACK will be sent

        // Create a test message
        const testMessage = new DocMessage(
          "test-doc",
          { type: "sync-done" },
          {
            clientId,
            userId: "user-1",
            room: "room-1",
          },
        );

        // Send message via writer endpoint
        // Since there's no reader, ACK will timeout
        const writerRequest = new Request("http://example.com/sse", {
          method: "POST",
          headers: {
            "x-teleportal-client-id": clientId,
          },
          body: encodeMessageArray([testMessage]) as unknown as BodyInit,
        });

        const startTime = Date.now();
        const writerResponse = await writerEndpoint(writerRequest);
        const elapsed = Date.now() - startTime;

        // Should return 504 Gateway Timeout when ACK is not received
        // Should timeout after approximately 100ms (ackTimeout)
        expect(writerResponse.status).toBe(504);
        expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some margin
        expect(elapsed).toBeLessThan(500); // Should not take much longer
        const json = await writerResponse.json();
        expect(json.error).toBe("Failed to receive acknowledgment");
        expect(json.message).toContain("ACK timeout");
      });
    });
  });
});
