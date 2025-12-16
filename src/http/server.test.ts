import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLogger } from "@logtape/logtape";
import {
  InMemoryPubSub,
  type ServerContext,
  type StateVector,
} from "teleportal";
import type { IdMap } from "yjs";
import {
  DocumentStorage,
  type AttributionMetadata,
} from "teleportal/storage";
import { Server } from "../server/server";
import { getHTTPHandler } from "./server";

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
  handleSyncStep2(
    key: string,
    syncStep2: any,
    attribution?: AttributionMetadata,
  ): Promise<void> {
    void attribution;
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

  async write(
    documentId: string,
    update: any,
    attribution?: AttributionMetadata,
  ) {
    void attribution;
    this.storedData = update;
  }

  async getAttributions(_key: string): Promise<IdMap<any>> {
    return new Map() as IdMap<any>;
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

describe("getHTTPHandler", () => {
  let server: Server<ServerContext>;
  let mockGetStorage: any;
  let pubSub: InMemoryPubSub;
  let mockGetContext: (
    req: Request,
  ) => Promise<Omit<ServerContext, "clientId">>;
  let handler: (req: Request) => Response | Promise<Response>;

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
    });

    handler = getHTTPHandler({
      server,
      getContext: mockGetContext,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  describe("routing", () => {
    it("should route GET /sse to SSE reader endpoint", async () => {
      const request = new Request("http://example.com/sse", {
        method: "GET",
      });

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("should route POST /sse to SSE writer endpoint", async () => {
      const request = new Request("http://example.com/sse", {
        method: "POST",
        headers: {
          "x-teleportal-client-id": "client-123",
        },
        body: new Uint8Array(),
      });

      const response = await handler(request);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.message).toBe("ok");
    });

    it("should route POST /message to HTTP endpoint", async () => {
      const request = new Request("http://example.com/message", {
        method: "POST",
        body: new Uint8Array(),
      });

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "application/octet-stream",
      );
    });

    it("should return 404 for unknown routes", async () => {
      const request = new Request("http://example.com/unknown", {
        method: "GET",
      });

      const response = await handler(request);

      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toBe("Not Found");
    });

    it("should return 404 for wrong method on /sse", async () => {
      const request = new Request("http://example.com/sse", {
        method: "PUT",
      });

      const response = await handler(request);

      expect(response.status).toBe(404);
    });

    it("should return 404 for wrong method on /message", async () => {
      const request = new Request("http://example.com/message", {
        method: "GET",
      });

      const response = await handler(request);

      expect(response.status).toBe(404);
    });

    it("should handle query parameters in URL", async () => {
      const request = new Request(
        "http://example.com/sse?documents=doc-1&client-id=test-client",
        {
          method: "GET",
        },
      );

      const response = await handler(request);

      expect(response.status).toBe(200);
    });

    it("should handle different base URLs with correct pathname", async () => {
      // The handler matches exact pathnames, so /sse should work regardless of domain
      const request = new Request("https://api.example.com/sse", {
        method: "GET",
      });

      const response = await handler(request);

      expect(response.status).toBe(200);
    });

    it("should return 404 for paths that don't match exactly", async () => {
      // Paths must match exactly - /v1/sse doesn't match /sse
      const request = new Request("https://api.example.com/v1/sse", {
        method: "GET",
      });

      const response = await handler(request);

      expect(response.status).toBe(404);
    });
  });

  describe("with getInitialDocuments", () => {
    it("should pass getInitialDocuments to SSE reader endpoint", async () => {
      const customGetInitialDocuments = () => [
        { document: "custom-doc", encrypted: false },
      ];

      const handlerWithInitialDocs = getHTTPHandler({
        server,
        getContext: mockGetContext,
        getInitialDocuments: customGetInitialDocuments,
      });

      const request = new Request("http://example.com/sse", {
        method: "GET",
      });

      const response = await handlerWithInitialDocs(request);

      expect(response.status).toBe(200);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify session was created with custom document
      const session = await server.getOrOpenSession("custom-doc", {
        encrypted: false,
        context: { userId: "user-1", room: "room", clientId: "client-1" },
      });
      expect(session).toBeDefined();
    });

    it("should work without getInitialDocuments", async () => {
      const handlerWithoutInitialDocs = getHTTPHandler({
        server,
        getContext: mockGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "GET",
      });

      const response = await handlerWithoutInitialDocs(request);

      expect(response.status).toBe(200);
    });
  });

  describe("error handling", () => {
    it("should handle errors in getContext gracefully", async () => {
      const errorGetContext = async () => {
        throw new Error("Context error");
      };

      const errorHandler = getHTTPHandler({
        server,
        getContext: errorGetContext,
      });

      const request = new Request("http://example.com/sse", {
        method: "GET",
      });

      await expect(errorHandler(request)).rejects.toThrow("Context error");
    });

    it("should handle SSE writer endpoint errors", async () => {
      const request = new Request("http://example.com/sse", {
        method: "POST",
        // No client ID - should return 400
      });

      const response = await handler(request);

      expect(response.status).toBe(400);
    });
  });

  describe("integration", () => {
    it("should handle full request flow", async () => {
      // GET /sse to establish connection
      const sseRequest = new Request(
        "http://example.com/sse?documents=test-doc",
        {
          method: "GET",
        },
      );

      const sseResponse = await handler(sseRequest);
      expect(sseResponse.status).toBe(200);

      // POST /sse to send message
      const clientId = sseResponse.headers.get("x-teleportal-client-id")!;
      const writerRequest = new Request("http://example.com/sse", {
        method: "POST",
        headers: {
          "x-teleportal-client-id": clientId,
        },
        body: new Uint8Array(),
      });

      const writerResponse = await handler(writerRequest);
      expect(writerResponse.status).toBe(200);

      // POST /message for direct HTTP endpoint
      const messageRequest = new Request("http://example.com/message", {
        method: "POST",
        body: new Uint8Array(),
      });

      const messageResponse = await handler(messageRequest);
      expect(messageResponse.status).toBe(200);
    });
  });
});
