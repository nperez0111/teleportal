import { beforeEach, describe, expect, it } from "bun:test";
import { ConsoleTransport, LogLayer } from "loglayer";
import type {
  ClientContext,
  Message,
  ServerContext,
  Transport,
} from "teleportal";
import { FileMessage } from "../lib/protocol/message-types";
import { InMemoryFileStorage } from "../storage/in-memory/file-storage";
import { getFileTransport } from "../transports/send-file";
import { FileHandler } from "./file-handler";
import { fromBase64 } from "lib0/buffer";

const emptyLogger = new LogLayer({
  transport: new ConsoleTransport({
    logger: console,
    enabled: false,
  }),
});

/**
 * Mock bidirectional transport for testing
 * Connects file transport (client) and FileHandler (server) together
 */
class MockBidirectionalTransport<Context extends Record<string, unknown>>
  implements Transport<Context>
{
  public readable: ReadableStream<Message<Context>>;
  public writable: WritableStream<Message<Context>>;
  [key: string]: unknown;
  private serverReadableController: ReadableStreamDefaultController<
    Message<Context>
  > | null = null;
  private clientReadableController: ReadableStreamDefaultController<
    Message<Context>
  > | null = null;
  private serverWritable: WritableStream<Message<Context>>;
  private clientWritable: WritableStream<Message<Context>>;
  private serverReadable: ReadableStream<Message<Context>>;
  private clientReadable: ReadableStream<Message<Context>>;

  constructor() {
    // Server readable: receives messages from client
    this.serverReadable = new ReadableStream<Message<Context>>({
      start: (controller) => {
        this.serverReadableController = controller;
      },
    });

    // Client writable: messages written here go to server readable
    // Use a custom class to handle multiple getWriter() calls
    this.clientWritable = new (class extends WritableStream<Message<Context>> {
      private controller: ReadableStreamDefaultController<
        Message<Context>
      > | null;

      constructor(
        controller: ReadableStreamDefaultController<Message<Context>> | null,
      ) {
        super({
          write: async (message) => {
            if (controller) {
              controller.enqueue(message);
            }
          },
        });
        this.controller = controller;
      }

      getWriter() {
        // Always return a new writer that auto-releases
        const writer = super.getWriter();
        return {
          ...writer,
          write: async (chunk: Message<Context>) => {
            try {
              await writer.write(chunk);
            } finally {
              writer.releaseLock();
            }
          },
          releaseLock: writer.releaseLock.bind(writer),
          close: writer.close.bind(writer),
          abort: writer.abort.bind(writer),
          desiredSize: writer.desiredSize,
          ready: writer.ready,
          closed: writer.closed,
        };
      }
    })(this.serverReadableController);

    // Client readable: receives messages from server
    this.clientReadable = new ReadableStream<Message<Context>>({
      start: (controller) => {
        this.clientReadableController = controller;
      },
    });

    // Server writable: messages written here go to client readable
    this.serverWritable = new WritableStream<Message<Context>>({
      write: async (message) => {
        if (this.clientReadableController) {
          this.clientReadableController.enqueue(message);
        }
      },
    });

    // Default readable/writable for the transport interface
    this.readable = this.clientReadable;
    this.writable = this.clientWritable;
  }

  // Helper to get server-side transport for FileHandler
  getServerTransport(): {
    readable: ReadableStream<Message<ServerContext>>;
    writable: WritableStream<Message<ServerContext>>;
  } {
    return {
      readable: this.serverReadable as unknown as ReadableStream<
        Message<ServerContext>
      >,
      writable: this.serverWritable as unknown as WritableStream<
        Message<ServerContext>
      >,
    };
  }

  // Helper to get client-side transport for file transport
  getClientTransport(): Transport<Context> {
    return {
      readable: this.clientReadable,
      writable: this.clientWritable,
    } as Transport<Context>;
  }

  close() {
    this.serverReadableController?.close();
    this.clientReadableController?.close();
  }
}

describe("FileHandler integration with file transport", () => {
  let fileStorage: InMemoryFileStorage;
  let fileHandler: FileHandler<ServerContext>;
  let transport: MockBidirectionalTransport<ClientContext>;

  beforeEach(() => {
    fileStorage = new InMemoryFileStorage();
    fileHandler = new FileHandler(fileStorage, emptyLogger);
    transport = new MockBidirectionalTransport<ClientContext>();
  });

  it("should handle file upload from file transport", async () => {
    const context: ClientContext = { clientId: "client-1" };
    const serverContext: ServerContext = {
      clientId: "client-1",
      userId: "user-1",
      room: "room-1",
    };

    // Create a test file
    const fileContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const file = new File([fileContent], "test.txt", {
      type: "text/plain",
    });

    // Set up message handler for server side
    const serverTransport = transport.getServerTransport();
    const reader = serverTransport.readable.getReader();
    const writer = serverTransport.writable.getWriter();

    // Start reading messages on server side
    const handleMessages = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          await fileHandler.handle(value, async (response) => {
            await writer.write(response);
          });
        }
      } catch (error) {
        // Ignore errors when stream closes
      } finally {
        reader.releaseLock();
      }
    };

    // Start handling messages
    const handlePromise = handleMessages();

    // Wrap transport with file transport and upload the file
    const clientTransport = transport.getClientTransport();
    const fileTransport = getFileTransport({
      transport: clientTransport,
      context,
    });
    const fileId = await fileTransport.upload(file, "test-file-id");

    // Wait a bit for all messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Close transport
    transport.close();
    await handlePromise;

    // Verify file was stored - convert hex string to Uint8Array
    const contentId = fromBase64(fileId);
    const storedFile = await fileStorage.getFile(contentId);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.metadata.filename).toBe("test.txt");
    expect(storedFile!.metadata.size).toBe(fileContent.length);
    expect(storedFile!.chunks.length).toBeGreaterThan(0);

    // Verify upload session was removed
    const progress = await fileStorage.getUploadProgress(fileId);
    expect(progress).toBeNull();
  });

  it("should handle multiple chunk upload", async () => {
    const context: ClientContext = { clientId: "client-1" };

    // Create a larger file that will be split into multiple chunks
    const fileSize = 100 * 1024; // 100KB (will be ~2 chunks at 64KB each)
    const fileContent = new Uint8Array(fileSize);
    fileContent.fill(42); // Fill with a test value

    const file = new File([fileContent], "large-test.txt", {
      type: "text/plain",
    });

    // Set up message handler for server side
    const serverTransport = transport.getServerTransport();
    const reader = serverTransport.readable.getReader();
    const writer = serverTransport.writable.getWriter();

    // Start reading messages on server side
    const handleMessages = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          await fileHandler.handle(value, async (response) => {
            await writer.write(response);
          });
        }
      } catch (error) {
        // Ignore errors when stream closes
      } finally {
        reader.releaseLock();
      }
    };

    // Start handling messages
    const handlePromise = handleMessages();

    // Wrap transport with file transport and upload the file
    const clientTransport = transport.getClientTransport();
    const fileTransport = getFileTransport({
      transport: clientTransport,
      context,
    });
    const fileId = await fileTransport.upload(file, "test-file-id");

    // Wait a bit for all messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Close transport
    transport.close();
    await handlePromise;

    // Verify file was stored - convert hex string to Uint8Array
    const contentId = fromBase64(fileId);
    const storedFile = await fileStorage.getFile(contentId);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.metadata.filename).toBe("large-test.txt");
    expect(storedFile!.metadata.size).toBe(fileSize);
    expect(storedFile!.chunks.length).toBeGreaterThan(1); // Should have multiple chunks
  });

  it("should handle file download request", async () => {
    const context: ClientContext = { clientId: "client-1" };

    // First, upload a file
    const fileContent = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([fileContent], "test.txt", {
      type: "text/plain",
    });

    // Set up message handler for server side
    const serverTransport = transport.getServerTransport();
    const reader = serverTransport.readable.getReader();
    const writer = serverTransport.writable.getWriter();

    const handleMessages = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          await fileHandler.handle(value, async (response) => {
            await writer.write(response);
          });
        }
      } catch (error) {
        // Ignore errors when stream closes
      } finally {
        reader.releaseLock();
      }
    };

    const handlePromise = handleMessages();

    // Upload file
    const clientTransport = transport.getClientTransport();
    const fileTransport = getFileTransport({
      transport: clientTransport,
      context,
    });
    const fileId = await fileTransport.upload(file, "test-file-id");

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Now request download - fileId is the merkle root hash (hex string)
    const downloadMessage = new FileMessage<ClientContext>(
      {
        type: "file-request",
        direction: "download",
        fileId,
        filename: "",
        size: 0,
        mimeType: "",
      },
      context,
      false,
    );

    const downloadTransport = transport.getClientTransport();
    await downloadTransport.writable.getWriter().write(downloadMessage);

    await new Promise((resolve) => setTimeout(resolve, 10));

    transport.close();
    await handlePromise;

    // Verify file exists - convert hex string to Uint8Array
    const contentId = fromBase64(fileId);
    const storedFile = await fileStorage.getFile(contentId);
    expect(storedFile).not.toBeNull();
  });
});
