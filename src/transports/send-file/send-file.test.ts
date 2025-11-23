import { describe, expect, it } from "bun:test";
import { toBase64 } from "lib0/buffer";
import { AckMessage, ClientContext, FileMessage, Message } from "teleportal";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "../../lib/merkle-tree/merkle-tree";
import { noopTransport, withPassthrough } from "../passthrough";
import { withSendFile } from "./send-file";
import { importEncryptionKey } from "teleportal/encryption-key";

describe("withSendFile", () => {
  it("should upload a small file successfully", async () => {
    const transportReadMessages: Message<ClientContext>[] = [];
    const transportWriteMessages: Message<ClientContext>[] = [];
    const transport = withPassthrough<ClientContext, {}>(noopTransport(), {
      onRead: (chunk) => {
        transportReadMessages.push(chunk);
      },
      onWrite: (chunk) => {
        transportWriteMessages.push(chunk);
      },
    });
    const wrappedTransport = withSendFile({
      transport: transport,
    });

    const writer = wrappedTransport.writable.getWriter();
    const receivedMessages: Message<ClientContext>[] = [];
    wrappedTransport.readable.pipeTo(
      new WritableStream({
        write: (chunk) => {
          receivedMessages.push(chunk);
        },
      }),
    );

    // start the upload, but we need to act as the server in-between, so just wait for it
    const uploadPromise = wrappedTransport.upload(
      new File([new Uint8Array([1, 2, 3, 4, 5])], "test.txt"),
      "test-doc",
      "test-file-id",
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation
    expect(receivedMessages.length).toBe(1);
    // check what we received
    const message = receivedMessages[0] as FileMessage<ClientContext>;

    // assert expectation
    expect(message.payload.type).toBe("file-upload");
    // clear the queue of received messages
    receivedMessages.pop();
    // act as the server and send a file-download message (acknowledge to allow the upload to continue)
    await writer.write(
      new FileMessage("test-doc", {
        type: "file-download",
        fileId: message.payload.fileId,
      }),
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));
    // assert expectation
    expect(receivedMessages.length).toBe(1);
    // check what we received
    const downloadMessage = receivedMessages[0] as FileMessage<ClientContext>;
    // assert expectation
    expect(downloadMessage.payload.type).toBe("file-part");
    // clear the queue of received messages
    receivedMessages.pop();

    // ACK the file-part message, so the client knows the file-part was received
    await writer.write(
      new AckMessage({
        type: "ack",
        messageId: downloadMessage.id,
      }),
    );

    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Upload should be complete, so check the client's result
    const uploadResult = await uploadPromise;
    // assert expectation
    expect(uploadResult).toBe("dPgf4WfZm0y0HW0MzagieMrunz4vJdXlo5Nv89zsYNA=");
  });

  it("should upload a file larger than one chunk", async () => {
    const transportReadMessages: Message<ClientContext>[] = [];
    const transportWriteMessages: Message<ClientContext>[] = [];
    const transport = withPassthrough<ClientContext, {}>(noopTransport(), {
      onRead: (chunk) => {
        transportReadMessages.push(chunk);
      },
      onWrite: (chunk) => {
        transportWriteMessages.push(chunk);
      },
    });
    const wrappedTransport = withSendFile({
      transport: transport,
    });

    const writer = wrappedTransport.writable.getWriter();
    const receivedMessages: Message<ClientContext>[] = [];
    wrappedTransport.readable.pipeTo(
      new WritableStream({
        write: (chunk) => {
          receivedMessages.push(chunk);
        },
      }),
    );

    // Create a file larger than one chunk
    const largeFileData = new Uint8Array(CHUNK_SIZE + 100);
    largeFileData.fill(42);
    const uploadPromise = wrappedTransport.upload(
      new File([largeFileData], "large.txt"),
      "test-doc",
      "large-file-id",
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive file-upload message
    expect(receivedMessages.length).toBe(1);
    const uploadMessage = receivedMessages[0] as FileMessage<ClientContext>;
    expect(uploadMessage.payload.type).toBe("file-upload");
    const fileId = uploadMessage.payload.fileId;
    receivedMessages.pop();

    // act as the server and send a file-download message
    await writer.write(
      new FileMessage("test-doc", {
        type: "file-download",
        fileId: fileId,
      }),
    );
    // let it be received async - client will send all chunks immediately
    await new Promise((resolve) => setTimeout(resolve, 10));

    // assert expectation - should receive both file-parts (client sends all chunks at once)
    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    const part1Message = receivedMessages[0] as FileMessage<ClientContext>;
    expect(part1Message.payload.type).toBe("file-part");
    expect((part1Message.payload as any).chunkIndex).toBe(0);
    receivedMessages.shift();

    // ACK the first file-part
    await writer.write(
      new AckMessage({
        type: "ack",
        messageId: part1Message.id,
      }),
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive second file-part
    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    const part2Message = receivedMessages[0] as FileMessage<ClientContext>;
    expect(part2Message.payload.type).toBe("file-part");
    expect((part2Message.payload as any).chunkIndex).toBe(1);
    receivedMessages.shift();

    // ACK the second file-part
    await writer.write(
      new AckMessage({
        type: "ack",
        messageId: part2Message.id,
      }),
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Upload should be complete
    const uploadResult = await uploadPromise;
    expect(uploadResult).toBeDefined();
    expect(typeof uploadResult).toBe("string");
  });

  it("should download a file successfully", async () => {
    const transportReadMessages: Message<ClientContext>[] = [];
    const transportWriteMessages: Message<ClientContext>[] = [];
    const transport = withPassthrough<ClientContext, {}>(noopTransport(), {
      onRead: (chunk) => {
        transportReadMessages.push(chunk);
      },
      onWrite: (chunk) => {
        transportWriteMessages.push(chunk);
      },
    });
    const wrappedTransport = withSendFile({
      transport: transport,
    });

    const writer = wrappedTransport.writable.getWriter();
    const receivedMessages: Message<ClientContext>[] = [];
    wrappedTransport.readable.pipeTo(
      new WritableStream({
        write: (chunk) => {
          receivedMessages.push(chunk);
        },
      }),
    );

    // Prepare file data and calculate contentId (merkle root) first
    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleTree = buildMerkleTree([fileData]);
    const contentId = toBase64(
      merkleTree.nodes[merkleTree.nodes.length - 1].hash!,
    );

    // Start the download with the contentId
    const downloadPromise = wrappedTransport.download(
      contentId,
      "test-doc",
      false,
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive file-download request
    expect(receivedMessages.length).toBe(1);
    const downloadRequest = receivedMessages[0] as FileMessage<ClientContext>;
    expect(downloadRequest.payload.type).toBe("file-download");
    expect((downloadRequest.payload as any).fileId).toBe(contentId);
    receivedMessages.pop();

    // act as the server and send file-upload (metadata) message with the contentId

    await writer.write(
      new FileMessage("test-doc", {
        type: "file-upload",
        fileId: contentId, // This should be the contentId (merkle root)
        filename: "downloaded.txt",
        size: 5,
        mimeType: "text/plain",
        lastModified: Date.now(),
        encrypted: false,
      }),
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Server should now send the file-part with proper merkle proof
    const proof = generateMerkleProof(merkleTree, 0);
    await writer.write(
      new FileMessage("test-doc", {
        type: "file-part",
        fileId: contentId,
        chunkIndex: 0,
        chunkData: fileData,
        merkleProof: proof,
        totalChunks: 1,
        bytesUploaded: 5,
        encrypted: false,
      } as any),
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Download should complete
    const downloadedFile = await downloadPromise;
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe("downloaded.txt");
    expect(downloadedFile.size).toBe(5);
  });

  it("should handle encrypted file upload", async () => {
    const transportReadMessages: Message<ClientContext>[] = [];
    const transportWriteMessages: Message<ClientContext>[] = [];
    const transport = withPassthrough<ClientContext, {}>(noopTransport(), {
      onRead: (chunk) => {
        transportReadMessages.push(chunk);
      },
      onWrite: (chunk) => {
        transportWriteMessages.push(chunk);
      },
    });
    const wrappedTransport = withSendFile({
      transport: transport,
    });

    const writer = wrappedTransport.writable.getWriter();
    const receivedMessages: Message<ClientContext>[] = [];
    wrappedTransport.readable.pipeTo(
      new WritableStream({
        write: (chunk) => {
          receivedMessages.push(chunk);
        },
      }),
    );

    const encryptionKey = await importEncryptionKey(
      "NIjJtEuEisDCgF9TL123lUSoqzthUFlpWQcaH6j-vco",
    );
    // start the encrypted upload
    const uploadPromise = wrappedTransport.upload(
      new File([new Uint8Array([1, 2, 3, 4, 5])], "encrypted.txt"),
      "test-doc",
      "encrypted-file-id",
      encryptionKey,
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation
    expect(receivedMessages.length).toBe(1);
    const message = receivedMessages[0] as FileMessage<ClientContext>;
    expect(message.payload.type).toBe("file-upload");
    expect((message.payload as any).encrypted).toBe(true);
    receivedMessages.pop();

    // act as the server and send a file-download message
    await writer.write(
      new FileMessage("test-doc", {
        type: "file-download",
        fileId: message.payload.fileId,
      }),
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation
    expect(receivedMessages.length).toBe(1);
    const downloadMessage = receivedMessages[0] as FileMessage<ClientContext>;
    expect(downloadMessage.payload.type).toBe("file-part");
    receivedMessages.pop();

    // ACK the file-part message
    await writer.write(
      new AckMessage({
        type: "ack",
        messageId: downloadMessage.id,
      }),
    );

    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Upload should be complete
    const uploadResult = await uploadPromise;
    expect(uploadResult).toBeDefined();
    expect(typeof uploadResult).toBe("string");
  });

  it("should track active uploads and downloads", async () => {
    const transport = withPassthrough<ClientContext, {}>(noopTransport());
    const wrappedTransport = withSendFile({
      transport: transport,
    });

    // Initially, there should be no active uploads or downloads
    expect(wrappedTransport.activeUploads.size).toBe(0);
    expect(wrappedTransport.activeDownloads.size).toBe(0);

    const writer = wrappedTransport.writable.getWriter();
    const receivedMessages: Message<ClientContext>[] = [];
    wrappedTransport.readable.pipeTo(
      new WritableStream({
        write: (chunk) => {
          receivedMessages.push(chunk);
        },
      }),
    );

    // Start an upload
    const uploadPromise = wrappedTransport.upload(
      new File([new Uint8Array([1, 2, 3])], "tracking.txt"),
      "test-doc",
      "tracking-file-id",
    );
    // let it be received async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Should have one active upload
    expect(wrappedTransport.activeUploads.size).toBe(1);
    expect(wrappedTransport.activeUploads.has("tracking-file-id")).toBe(true);

    // Complete the upload
    const uploadMessage = receivedMessages[0] as FileMessage<ClientContext>;
    receivedMessages.pop();
    await writer.write(
      new FileMessage("test-doc", {
        type: "file-download",
        fileId: uploadMessage.payload.fileId,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));

    const partMessage = receivedMessages[0] as FileMessage<ClientContext>;
    receivedMessages.pop();
    await writer.write(
      new AckMessage({
        type: "ack",
        messageId: partMessage.id,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));

    await uploadPromise;

    // After completion, upload should be removed
    expect(wrappedTransport.activeUploads.size).toBe(0);
  });
});
