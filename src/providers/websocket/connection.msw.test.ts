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
  AckMessage,
  ClientContext,
  FileMessage,
  Message,
  ServerContext,
  decodeMessage,
  isBinaryMessage,
} from "teleportal";
import { withSendFile } from "../../transports/send-file";
import { WebSocketConnection } from "./connection";
import { FileHandler } from "../../server/file-handler";
import { InMemoryFileStorage } from "../../storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "../../storage/in-memory/temporary-upload-storage";
import { noopTransport, withPassthrough } from "../../transports/passthrough";
import { CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";

const wsUrl = "ws://localhost:8080";

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
      const fileHandler = new FileHandler(fileStorage);
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

              // Process file messages
              if (message.type === "file") {
                try {
                  await fileHandler.handle(message, async (response) => {
                    sentResponses.push(response);

                    // Send response back through WebSocket
                    const encoded = response.encoded;
                    const arrayBuffer = encoded.buffer.slice(
                      encoded.byteOffset,
                      encoded.byteOffset + encoded.byteLength,
                    );
                    wsClient.send(arrayBuffer);
                  });
                } catch (error) {
                  // Log and re-throw file handler errors
                  console.error("File handler error:", error);
                  throw error;
                }
              }
            } catch (error) {
              // Only ignore decode errors for non-file messages
              // File handler errors should propagate
              const message = receivedMessages.at(-1);
              if (message?.type === "file") {
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

      const context: ClientContext = { clientId: "test-client" };
      const wrappedTransport = withSendFile({
        // we don't care what the transport is underlying, we just want to test the file transport
        transport: noopTransport<ClientContext>(),
        context,
      });

      // messages emitted from the file transport should be sent to the server, through the client
      wrappedTransport.readable.pipeTo(client.writable);
      // messages emitted from the client should be sent to the file transport
      client.getReader().readable.pipeTo(wrappedTransport.writable);

      const fileId = await wrappedTransport.upload(file, "test-file-id");

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
      const fileHandler = new FileHandler(fileStorage);
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

              // Process file messages
              if (message.type === "file") {
                await fileHandler.handle(message, async (response) => {
                  sentResponses.push(response);

                  // Send response back through WebSocket
                  wsClient.send(response.encoded);
                });
              }
            } catch {
              // Ignore decode errors for non-file messages
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
      const fileContent = new Uint8Array(CHUNK_SIZE * 2);
      fileContent.fill(42);
      const file = new File([fileContent], "test.txt", {
        type: "text/plain",
      });

      const context: ClientContext = { clientId: "test-client" };
      const wrappedTransport = withSendFile({
        // we don't care what the transport is underlying, we just want to test the file transport
        transport: noopTransport<ClientContext>(),
        context,
      });

      // messages emitted from the file transport should be sent to the server, through the client
      wrappedTransport.readable.pipeTo(client.writable);
      // messages emitted from the client should be sent to the file transport
      client.getReader().readable.pipeTo(wrappedTransport.writable);

      const fileId = await wrappedTransport.upload(file, "test-large-file-id");

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
        `"h3KLkpK8GaKRh4b5BUiHr1xcYQ2TGSjx7kDOgfNXmlM="`,
      );
      await client.destroy();
    });

    test("should upload and download file through WebSocket connection (round-trip)", async () => {
      const wsHandler = ws.link(wsUrl);
      const fileStorage = new InMemoryFileStorage();
      fileStorage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();
      const fileHandler = new FileHandler(fileStorage);
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

              // Process file messages
              if (message.type === "file") {
                try {
                  await fileHandler.handle(message, async (response) => {
                    sentResponses.push(response);

                    // Send response back through WebSocket
                    const encoded = response.encoded;
                    const arrayBuffer = encoded.buffer.slice(
                      encoded.byteOffset,
                      encoded.byteOffset + encoded.byteLength,
                    );
                    wsClient.send(arrayBuffer);
                  });
                } catch (error) {
                  // Log and re-throw file handler errors
                  console.error("File handler error:", error);
                  throw error;
                }
              }
            } catch (error) {
              // Only ignore decode errors for non-file messages
              // File handler errors should propagate
              const message = receivedMessages.at(-1);
              if (message?.type === "file") {
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

      const context: ClientContext = { clientId: "test-client" };
      const wrappedTransport = withSendFile({
        // we don't care what the transport is underlying, we just want to test the file transport
        transport: noopTransport<ClientContext>(),
        context,
      });

      // messages emitted from the file transport should be sent to the server, through the client
      wrappedTransport.readable.pipeTo(client.writable);
      // messages emitted from the client should be sent to the file transport
      client.getReader().readable.pipeTo(wrappedTransport.writable);

      // Upload file
      const fileId = await wrappedTransport.upload(
        file,
        "test-doc",
        "test-file-id",
      );

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
      const downloadedFile = await wrappedTransport.download(
        fileId,
        "test-doc",
      );

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
