import { Server, InMemoryBlobStorage, BlobStorageManager } from "./index";
import { logger } from "./logger";
import { BlobMessage } from "../protocol/message-types";
import { segmentFileForUpload } from "../protocol/utils";
import { DocumentStorage } from "../storage/document-storage";
import type { StateVector, Update } from "../protocol/types";
import { getEmptyUpdate, getEmptyStateVector } from "../protocol/utils";

// Example DocumentStorage implementation
class ExampleDocumentStorage extends DocumentStorage {
  public readonly type = "document-storage";
  public encrypted = false;

  async write(key: string, update: Update): Promise<void> {
    // In a real implementation, you would save the update to your storage
    console.log(`Writing update for document: ${key}`);
  }

  async fetch(key: string): Promise<{
    update: Update;
    stateVector: StateVector;
  } | null> {
    // In a real implementation, you would fetch from your storage
    console.log(`Fetching document: ${key}`);
    return {
      update: getEmptyUpdate(),
      stateVector: getEmptyStateVector(),
    };
  }

  async unload(key: string): Promise<void> {
    // In a real implementation, you would clean up resources
    console.log(`Unloading document: ${key}`);
  }
}

// Example of how to use the blob storage functionality

async function example() {
  // Create a server with blob storage enabled
  const server = new Server({
    logger,

    // Document storage (required)
    getStorage: async () => {
      return new ExampleDocumentStorage();
    },

    // Permission checking (required)
    checkPermission: async () => true,

    // Blob storage options (optional)
    blobStorage: {
      maxIncompleteBlobAge: 60 * 60 * 1000, // 1 hour
      maxIncompleteBlobs: 1000,
    },

    // Callback when a blob is complete (optional)
    onCompleteBlob: async (contentId, data, metadata) => {
      console.log(`Blob complete: ${contentId}`);
      console.log(`File: ${metadata.name} (${metadata.contentType})`);
      console.log(`Size: ${data.length} bytes`);

      // Here you would typically:
      // 1. Save the file to permanent storage (S3, local filesystem, etc.)
      // 2. Update your database with file metadata
      // 3. Notify other parts of your application

      // Example: Save to local filesystem
      // await Bun.write(`uploads/${contentId}`, data);
    },
  });

  // Create a client (in a real app, this would be done via WebSocket)
  const client = await server.createClient({
    transport: {
      readable: new ReadableStream(),
      writable: new WritableStream(),
    },
    context: {
      room: "example-room",
      userId: "user-123",
    },
  });

  // Example: Upload a file
  const fileData = new TextEncoder().encode("Hello, this is a test file!");
  const fileName = "test.txt";
  const contentType = "text/plain";
  const documentName = "example-doc";

  // Segment the file for upload
  const segments = segmentFileForUpload(
    fileData,
    fileName,
    contentType,
    documentName,
  );

  console.log(`File segmented into ${segments.length} parts`);

  // In a real application, you would send these segments to the server
  // via the WebSocket connection. The server will:
  // 1. Store each segment temporarily
  // 2. Check if all segments are received
  // 3. Call onCompleteBlob when the file is complete
  // 4. Make the file available for requests

  // Example: Request a file
  const requestMessage = new BlobMessage(
    documentName,
    {
      type: "request-blob",
      requestId: "req-123",
      contentId: "example-content-id",
      name: fileName,
    },
    {
      clientId: "client-123",
      room: "example-room",
      userId: "user-123",
    },
    false,
  );

  // The server will respond with the file segments if the blob is complete
  // or null if the blob doesn't exist or is incomplete

  console.log("Blob storage example completed");
}

// Run the example
example().catch(console.error);
