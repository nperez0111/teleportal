import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { ws } from "msw";
import { setupServer } from "msw/node";
import {
  ClientContext,
  decodeMessage,
  isBinaryMessage,
  Message,
  RpcMessage,
  ServerContext,
} from "teleportal";
import { CHUNK_SIZE } from "teleportal/merkle-tree";
import type { RpcHandlerRegistry, RpcServerContext } from "teleportal/protocol";
import {
  getFileClientHandlers,
  getFileRpcHandlers,
} from "../../protocols/file";
import type { FilePartStream } from "../../protocols/file/methods";
import { InMemoryFileStorage } from "../../storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "../../storage/in-memory/temporary-upload-storage";
import { YDocStorage } from "../../storage/in-memory/ydoc";
import { Provider } from "../provider";
import { WebSocketConnection } from "./connection";

const wsUrl = "ws://localhost:8080";

/**
 * Helper to process RPC messages using file RPC handlers.
 * Simulates how the Session processes RPC messages.
 */
async function processRpcMessage(
  handlers: RpcHandlerRegistry,
  message: RpcMessage<ServerContext>,
  sendMessage: (msg: Message<ServerContext>) => Promise<void>,
): Promise<void> {
  const handler = handlers[message.rpcMethod];
  if (!handler) return;

  // Create a storage instance for document metadata management
  const documentStorage = new YDocStorage();

  const context: RpcServerContext = {
    server: {} as any,
    documentId: message.document ?? "",
    session: {
      storage: documentStorage,
    } as any,
  };

  if (message.requestType === "request" && message.payload.type === "success") {
    const result = await handler.handler(message.payload.payload, context);

    // Send stream chunks first if present
    if (result.stream) {
      for await (const chunk of result.stream) {
        await sendMessage(
          new RpcMessage(
            message.document ?? "",
            { type: "success" as const, payload: chunk },
            message.rpcMethod,
            "stream",
            message.id,
            message.context,
            message.encrypted,
          ),
        );
      }
    }

    // Send response
    const responsePayload =
      (result.response as { type?: string }).type === "error"
        ? (result.response as {
            type: "error";
            statusCode: number;
            details: string;
          })
        : { type: "success" as const, payload: result.response };

    await sendMessage(
      new RpcMessage(
        message.document ?? "",
        responsePayload,
        message.rpcMethod,
        "response",
        message.id,
        message.context,
        message.encrypted,
      ),
    );
  } else if (
    message.requestType === "stream" &&
    message.payload.type === "success" &&
    handler.streamHandler
  ) {
    await handler.streamHandler(
      message.payload.payload as FilePartStream,
      context,
      message.id,
      sendMessage,
    );
  }
}

function connectionToTransport(
  connection: WebSocketConnection,
): import("teleportal").Transport<ClientContext> {
  return {
    readable: connection.getReader().readable,
    writable: connection.writable,
  };
}

// Skip MSW WebSocket tests in CI due to timing issues with MSW WebSocket interception
// These tests are still valuable for local development
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

// Use describe.skip in CI, otherwise run normally
const describeOrSkip = isCI ? describe.skip : describe;

describeOrSkip("WebSocketConnection with MSW", () => {
  const server = setupServer();
  let client: WebSocketConnection;

  beforeAll(() => {
    server.listen({ onUnhandledRequest: "bypass" });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    server.resetHandlers();
  });

  afterEach(async () => {
    if (client) {
      if (
        client.state.type === "connected" ||
        client.state.type === "connecting"
      ) {
        await client.disconnect();
      }
      await client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    server.resetHandlers();
  });

  describe("File uploads", () => {
    test("should upload file through WebSocket connection", async () => {
      const wsHandler = ws.link(wsUrl);
      const fileStorage = new InMemoryFileStorage();
      fileStorage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();
      const handlers = getFileRpcHandlers(fileStorage);
      const receivedMessages: Message<ServerContext>[] = [];
      const sentResponses: Message<ServerContext>[] = [];

      server.use(
        wsHandler.addEventListener("connection", ({ client: wsClient }) => {
          wsClient.addEventListener("message", async (event) => {
            const data = new Uint8Array(event.data as ArrayBuffer);
            try {
              if (!isBinaryMessage(data)) {
                return;
              }

              // Decode message
              const decoded = decodeMessage(data);
              const message = decoded as Message<ServerContext>;
              receivedMessages.push(message);

              // Only process RPC messages through file handlers
              if (message.type === "rpc") {
                try {
                  await processRpcMessage(
                    handlers,
                    message as RpcMessage<ServerContext>,
                    async (response) => {
                      sentResponses.push(response);

                      // Send response back through WebSocket
                      const encoded = response.encoded;
                      const arrayBuffer = encoded.buffer.slice(
                        encoded.byteOffset,
                        encoded.byteOffset + encoded.byteLength,
                      );
                      wsClient.send(arrayBuffer);
                    },
                  );
                } catch (error) {
                  // Log and re-throw file handler errors
                  console.error("File handler error:", error);
                  throw error;
                }
              }
            } catch (error) {
              // Only ignore decode errors for non-RPC messages
              // RPC handler errors should propagate
              const message = receivedMessages.at(-1);
              if (message?.type === "rpc") {
                throw error;
              }
            }
          });
        }),
      );

      client = new WebSocketConnection({
        url: wsUrl,
        connect: true,
      });

      await client.connected;

      // Create a test file
      const fileContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const file = new File([fileContent], "test.txt", {
        type: "text/plain",
      });

      // Use Provider with rpcHandlers instead of withSendFile
      const provider = await Provider.create({
        connection: client,
        document: "test-doc",
        rpcHandlers: {
          ...getFileClientHandlers(),
        },
      });

      const fileId = await provider.uploadFile(file, "test-file-id");

      // wait for the storage to be updated with retries
      let storedFile = await fileStorage.getFile(fileId);
      for (let i = 0; i < 10 && !storedFile; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        storedFile = await fileStorage.getFile(fileId);
      }

      // Verify file was stored
      expect(storedFile).not.toBeNull();
      expect(storedFile!.metadata.filename).toBe("test.txt");
      expect(storedFile!.metadata.size).toBe(fileContent.length);
      expect(fileId).toMatchInlineSnapshot(
        `"yEjhAT+fBKnWP6Q85/1K8DUVLHxmmkpAS2cQfO5fLk4="`,
      );
      await client.destroy();
    });
    test("should upload large file through WebSocket connection", async () => {
      const wsHandler = ws.link(wsUrl);
      const fileStorage = new InMemoryFileStorage();
      fileStorage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();
      const handlers = getFileRpcHandlers(fileStorage);
      const receivedMessages: Message<ServerContext>[] = [];
      const sentResponses: Message<ServerContext>[] = [];

      // Use a mutex to ensure sequential message processing
      // This prevents race conditions when multiple chunks arrive concurrently
      let processingPromise = Promise.resolve();

      server.use(
        wsHandler.addEventListener("connection", ({ client: wsClient }) => {
          wsClient.addEventListener("message", (event) => {
            // Queue message processing to ensure sequential handling
            processingPromise = processingPromise.then(async () => {
              const data = new Uint8Array(event.data as ArrayBuffer);
              try {
                if (!isBinaryMessage(data)) {
                  return;
                }

                // Decode message
                const decoded = decodeMessage(data);
                const message = decoded as Message<ServerContext>;
                receivedMessages.push(message);

                // Only process RPC messages through file handlers
                if (message.type === "rpc") {
                  try {
                    await processRpcMessage(
                      handlers,
                      message as RpcMessage<ServerContext>,
                      async (response) => {
                        sentResponses.push(response);

                        // Send response back through WebSocket
                        const encoded = response.encoded;
                        const arrayBuffer = encoded.buffer.slice(
                          encoded.byteOffset,
                          encoded.byteOffset + encoded.byteLength,
                        );
                        wsClient.send(arrayBuffer);
                      },
                    );
                  } catch (error) {
                    // Log and re-throw file handler errors
                    console.error("File handler error:", error);
                    throw error;
                  }
                }
              } catch (error) {
                // Only ignore decode errors for non-RPC messages
                // RPC handler errors should propagate
                const message = receivedMessages.at(-1);
                if (message?.type === "rpc") {
                  throw error;
                }
              }
            });
          });
        }),
      );

      client = new WebSocketConnection({
        url: wsUrl,
        connect: true,
      });

      await client.connected;

      // Create a test file
      const fileContent = new Uint8Array(CHUNK_SIZE * 2);
      fileContent.fill(42);
      const file = new File([fileContent], "test.txt", {
        type: "text/plain",
      });

      // Use Provider with rpcHandlers instead of withSendFile
      const provider = await Provider.create({
        connection: client,
        document: "test-doc",
        rpcHandlers: {
          ...getFileClientHandlers(),
        },
      });

      const fileId = await provider.uploadFile(file, "test-large-file-id");

      // wait for the storage to be updated with retries (longer wait for large files)
      let storedFile = await fileStorage.getFile(fileId);
      for (let i = 0; i < 50 && !storedFile; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        storedFile = await fileStorage.getFile(fileId);
      }

      // Verify file was stored
      expect(storedFile).not.toBeNull();
      expect(storedFile!.metadata.filename).toBe("test.txt");
      expect(storedFile!.metadata.size).toBe(fileContent.length);
      expect(fileId).toMatchInlineSnapshot(
        `"h3KLkpK8GaKRh4b5BUiHr1xcYQ2TGSjx7kDOgfNXmlM="`,
      );
      await client.destroy();
    });

    test("should upload and download file through WebSocket connection (round-trip)", async () => {
      const wsHandler = ws.link(wsUrl);
      const fileStorage = new InMemoryFileStorage();
      fileStorage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();
      const handlers = getFileRpcHandlers(fileStorage);
      const receivedMessages: Message<ServerContext>[] = [];
      const sentResponses: Message<ServerContext>[] = [];

      server.use(
        wsHandler.addEventListener("connection", ({ client: wsClient }) => {
          wsClient.addEventListener("message", async (event) => {
            const data = new Uint8Array(event.data as ArrayBuffer);
            try {
              if (!isBinaryMessage(data)) {
                return;
              }

              // Decode message
              const decoded = decodeMessage(data);
              const message = decoded as Message<ServerContext>;
              receivedMessages.push(message);

              // Only process RPC messages through file handlers
              if (message.type === "rpc") {
                try {
                  await processRpcMessage(
                    handlers,
                    message as RpcMessage<ServerContext>,
                    async (response) => {
                      sentResponses.push(response);

                      // Send response back through WebSocket
                      const encoded = response.encoded;
                      const arrayBuffer = encoded.buffer.slice(
                        encoded.byteOffset,
                        encoded.byteOffset + encoded.byteLength,
                      );
                      wsClient.send(arrayBuffer);
                    },
                  );
                } catch (error) {
                  // Log and re-throw file handler errors
                  console.error("File handler error:", error);
                  throw error;
                }
              }
            } catch (error) {
              // Only ignore decode errors for non-RPC messages
              // RPC handler errors should propagate
              const message = receivedMessages.at(-1);
              if (message?.type === "rpc") {
                throw error;
              }
            }
          });
        }),
      );

      client = new WebSocketConnection({
        url: wsUrl,
        connect: true,
      });

      await client.connected;

      // Create a test file
      const fileContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const file = new File([fileContent], "test.txt", {
        type: "text/plain",
      });

      // Use Provider with rpcHandlers instead of withSendFile
      const provider = await Provider.create({
        connection: client,
        document: "test-doc",
        rpcHandlers: {
          ...getFileClientHandlers(),
        },
      });

      // Upload file
      const fileId = await provider.uploadFile(file, "test-file-id");

      // wait for the storage to be updated with retries
      let storedFile = await fileStorage.getFile(fileId);
      for (let i = 0; i < 10 && !storedFile; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        storedFile = await fileStorage.getFile(fileId);
      }

      // Verify file was stored
      expect(storedFile).not.toBeNull();
      expect(storedFile!.metadata.filename).toBe("test.txt");
      expect(storedFile!.metadata.size).toBe(fileContent.length);

      // Download file
      const downloadedFile = await provider.downloadFile(fileId);

      // Verify downloaded file matches original
      expect(downloadedFile).toBeInstanceOf(File);
      expect(downloadedFile.name).toBe("test.txt");
      expect(downloadedFile.size).toBe(fileContent.length);
      expect(downloadedFile.type).toContain("text/plain");

      // Compare file contents
      const downloadedContent = new Uint8Array(
        await downloadedFile.arrayBuffer(),
      );
      expect(downloadedContent.length).toBe(fileContent.length);
      expect(downloadedContent).toEqual(fileContent);

      await client.destroy();
    });
  });
});
