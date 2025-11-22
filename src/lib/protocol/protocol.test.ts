import { describe, expect, it } from "bun:test";
import {
  AckMessage,
  AwarenessMessage,
  AwarenessUpdateMessage,
  DecodedFilePart,
  decodeMessage,
  DocMessage,
  encodePingMessage,
  encodePongMessage,
  FileMessage,
  getEmptyStateVector,
  getEmptyUpdate,
  isEmptyStateVector,
  isEmptyUpdate,
  isPingMessage,
  isPongMessage,
  StateVector,
  SyncStep2Update,
  Update,
} from ".";
import { CHUNK_SIZE } from "../merkle-tree/merkle-tree";
import { toBase64 } from "lib0/buffer";

describe("can encode and decode", () => {
  it("can encode and decode an awareness update", () => {
    expect(
      decodeMessage(
        new AwarenessMessage("test", {
          type: "awareness-update",
          update: new Uint8Array([
            0x00, 0x01, 0x02, 0x03,
          ]) as AwarenessUpdateMessage,
        }).encoded,
      ),
    ).toMatchInlineSnapshot(`
      AwarenessMessage {
        "context": {},
        "document": "test",
        "encrypted": false,
        "payload": {
          "type": "awareness-update",
          "update": Uint8Array [
            0,
            1,
            2,
            3,
          ],
        },
        "type": "awareness",
      }
    `);
  });

  it("can encode and decode a doc update (sync step 1)", () => {
    expect(
      decodeMessage(
        new DocMessage("test", {
          type: "sync-step-1",
          sv: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as StateVector,
        }).encoded,
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "encrypted": false,
        "payload": {
          "sv": Uint8Array [
            0,
            1,
            2,
            3,
          ],
          "type": "sync-step-1",
        },
        "type": "doc",
      }
    `);
  });

  it("can encode and decode a doc update (sync step 2)", () => {
    expect(
      decodeMessage(
        new DocMessage("test", {
          type: "sync-step-2",
          update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as SyncStep2Update,
        }).encoded,
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "encrypted": false,
        "payload": {
          "type": "sync-step-2",
          "update": Uint8Array [
            0,
            1,
            2,
            3,
          ],
        },
        "type": "doc",
      }
    `);
  });

  it("can encode and decode a doc update (sync done)", () => {
    expect(
      decodeMessage(
        new DocMessage("test", {
          type: "sync-done",
        }).encoded,
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "encrypted": false,
        "payload": {
          "type": "sync-done",
        },
        "type": "doc",
      }
    `);
  });

  it("can encode and decode a doc update (update)", () => {
    expect(
      decodeMessage(
        new DocMessage("test", {
          type: "update",
          update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
        }).encoded,
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "encrypted": false,
        "payload": {
          "type": "update",
          "update": Uint8Array [
            0,
            1,
            2,
            3,
          ],
        },
        "type": "doc",
      }
    `);
  });

  it("can encode and decode a doc update (auth message)", () => {
    expect(
      decodeMessage(
        new DocMessage("test", {
          type: "auth-message",
          permission: "denied",
          reason: "test",
        }).encoded,
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "encrypted": false,
        "payload": {
          "permission": "denied",
          "reason": "test",
          "type": "auth-message",
        },
        "type": "doc",
      }
    `);
  });

  it("can encode and decode an ack message", () => {
    expect(
      decodeMessage(
        new AckMessage({
          type: "ack",
          messageId: "dGVzdA==", // base64 for "test"
        }).encoded,
      ),
    ).toMatchInlineSnapshot(`
      AckMessage {
        "context": {},
        "document": undefined,
        "encrypted": false,
        "payload": {
          "messageId": "dGVzdA==",
          "type": "ack",
        },
        "type": "ack",
      }
    `);
  });

  it("get it's id", () => {
    expect(
      new DocMessage("test", {
        type: "update",
        update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
      }).id,
    ).toMatchInlineSnapshot(`"wo8phd40Cygbec6rdBODugYv9Vn4sF5pJreXrb8uYFw="`);
  });

  it("ack message gets it's id", () => {
    expect(
      new AckMessage({
        type: "ack",
        messageId: "dGVzdA==",
      }).id,
    ).toBeDefined();
  });

  it("ack message preserves messageId through encode/decode", () => {
    const originalMessageId = "dGVzdA==";
    const ackMessage = new AckMessage({
      type: "ack",
      messageId: originalMessageId,
    });
    const decoded = decodeMessage(ackMessage.encoded);
    expect(decoded).toBeInstanceOf(AckMessage);
    if (decoded instanceof AckMessage) {
      expect(decoded.payload.messageId).toBe(originalMessageId);
    }
  });

  it("ack message can have context", () => {
    const ackMessage = new AckMessage(
      {
        type: "ack",
        messageId: "dGVzdA==",
      },
      { userId: "123" },
    );
    expect(ackMessage.context).toEqual({ userId: "123" });
    const decoded = decodeMessage(ackMessage.encoded);
    expect(decoded.context).toEqual({});
  });

  it("can encode and decode a file message (file-upload)", () => {
    expect(
      decodeMessage(
        new FileMessage<Record<string, unknown>>(
          "test-doc",
          {
            type: "file-upload",
            fileId: "test-upload-id",
            filename: "test.txt",
            size: 1024,
            mimeType: "text/plain",
            lastModified: 1763526701897,
            encrypted: false,
          },
          {},
          false,
        ).encoded,
      ),
    ).toMatchInlineSnapshot(`
      FileMessage {
        "context": {},
        "document": "test-doc",
        "encrypted": false,
        "payload": {
          "encrypted": false,
          "fileId": "test-upload-id",
          "filename": "test.txt",
          "lastModified": 1763526701897,
          "mimeType": "text/plain",
          "size": 1024,
          "type": "file-upload",
        },
        "type": "file",
      }
    `);
  });

  it("can encode and decode a file message (file-upload) with all fields", () => {
    const filePayload = {
      type: "file-upload" as const,
      fileId: "test-upload-id-detailed",
      filename: "detailed-test.txt",
      size: 12345,
      mimeType: "application/json",
      lastModified: 1763526701898,
      encrypted: true,
    };

    const originalMessage = new FileMessage<Record<string, unknown>>(
      "detailed-doc",
      filePayload,
      { userId: "user-123" },
      true, // message encrypted
    );

    const decoded = decodeMessage(originalMessage.encoded);

    expect(decoded).toBeInstanceOf(FileMessage);
    expect(decoded.document).toBe("detailed-doc");
    expect(decoded.encrypted).toBe(true); // Message encryption status

    // Check payload fields
    const payload = decoded.payload;
    if (payload.type !== "file-upload") {
      throw new Error("Expected payload type to be file-upload");
    }

    expect(payload.type).toBe(filePayload.type);
    expect(payload.fileId).toBe(filePayload.fileId);
    expect(payload.filename).toBe(filePayload.filename);
    expect(payload.size).toBe(filePayload.size);
    expect(payload.mimeType).toBe(filePayload.mimeType);
    expect(payload.lastModified).toBe(filePayload.lastModified);
    expect(payload.encrypted).toBe(filePayload.encrypted); // Payload encryption status
  });

  it("can encode and decode a file message (file-download)", () => {
    const contentId = new Uint8Array(32);
    contentId.fill(42);
    const fileId = toBase64(contentId);

    expect(
      decodeMessage(
        new FileMessage<Record<string, unknown>>(
          "test-doc",
          {
            type: "file-download",
            fileId,
          },
          {},
          false,
        ).encoded,
      ),
    ).toMatchInlineSnapshot(`
      FileMessage {
        "context": {},
        "document": "test-doc",
        "encrypted": false,
        "payload": {
          "fileId": "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=",
          "type": "file-download",
        },
        "type": "file",
      }
    `);
  });

  it("can encode and decode a file message (file-download) with all fields", () => {
    const filePayload = {
      type: "file-download" as const,
      fileId: "test-download-id",
    };

    const originalMessage = new FileMessage<Record<string, unknown>>(
      "download-doc",
      filePayload,
      { userId: "user-456" },
      false,
    );

    const decoded = decodeMessage(originalMessage.encoded);

    expect(decoded).toBeInstanceOf(FileMessage);
    expect(decoded.document).toBe("download-doc");
    expect(decoded.encrypted).toBe(false);

    const payload = decoded.payload;
    if (payload.type !== "file-download") {
      throw new Error("Expected payload type to be file-download");
    }

    expect(payload.type).toBe(filePayload.type);
    expect(payload.fileId).toBe(filePayload.fileId);
  });

  it("can encode and decode a file message (file-part)", () => {
    const chunkData = new Uint8Array(CHUNK_SIZE);
    chunkData.fill(1);

    const merkleProof = [
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
    ];

    const decoded = decodeMessage(
      new FileMessage<Record<string, unknown>>(
        "test-doc",
        {
          type: "file-part",
          fileId: "test-file-id",
          chunkIndex: 0,
          chunkData,
          merkleProof,
          totalChunks: 10,
          bytesUploaded: CHUNK_SIZE,
          encrypted: false,
        },
        {},
        false,
      ).encoded,
    );
    expect((decoded.payload as DecodedFilePart).chunkData).toBeTruthy();
    (decoded.payload as Partial<DecodedFilePart>).chunkData = undefined;

    expect(decoded).toMatchInlineSnapshot(`
      FileMessage {
        "context": {},
        "document": "test-doc",
        "encrypted": false,
        "payload": {
          "bytesUploaded": 65536,
          "chunkData": undefined,
          "chunkIndex": 0,
          "encrypted": false,
          "fileId": "test-file-id",
          "merkleProof": [
            Uint8Array [
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
              2,
            ],
            Uint8Array [
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
              3,
            ],
          ],
          "totalChunks": 10,
          "type": "file-part",
        },
        "type": "file",
      }
    `);
  });

  it("can encode and decode a file message (file-part) with all fields", () => {
    const chunkData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleProof = [
      new Uint8Array([10, 11, 12]),
      new Uint8Array([20, 21, 22]),
    ];

    const filePayload = {
      type: "file-part" as const,
      fileId: "test-part-id",
      chunkIndex: 5,
      chunkData: chunkData,
      merkleProof: merkleProof,
      totalChunks: 100,
      bytesUploaded: 5000,
      encrypted: true,
    };

    const originalMessage = new FileMessage<Record<string, unknown>>(
      "part-doc",
      filePayload,
      { userId: "user-789" },
      true,
    );

    const decoded = decodeMessage(originalMessage.encoded);

    expect(decoded).toBeInstanceOf(FileMessage);
    expect(decoded.document).toBe("part-doc");
    expect(decoded.encrypted).toBe(true);

    const payload = decoded.payload;
    if (payload.type !== "file-part") {
      throw new Error("Expected payload type to be file-part");
    }

    expect(payload.type).toBe(filePayload.type);
    expect(payload.fileId).toBe(filePayload.fileId);
    expect(payload.chunkIndex).toBe(filePayload.chunkIndex);
    expect(payload.chunkData).toEqual(filePayload.chunkData);
    expect(payload.merkleProof).toEqual(filePayload.merkleProof);
    expect(payload.totalChunks).toBe(filePayload.totalChunks);
    expect(payload.bytesUploaded).toBe(filePayload.bytesUploaded);
    expect(payload.encrypted).toBe(filePayload.encrypted);
  });

  it("file message (file-auth-message)", () => {
    expect(
      new FileMessage<Record<string, unknown>>("test-doc", {
        type: "file-auth-message",
        permission: "denied",
        fileId: "test-file-id",
        statusCode: 404,
        reason: "test",
      }).encoded,
    ).toMatchInlineSnapshot(`
      Uint8Array [
        89,
        74,
        83,
        1,
        8,
        116,
        101,
        115,
        116,
        45,
        100,
        111,
        99,
        0,
        3,
        3,
        0,
        12,
        116,
        101,
        115,
        116,
        45,
        102,
        105,
        108,
        101,
        45,
        105,
        100,
        148,
        3,
        1,
        4,
        116,
        101,
        115,
        116,
      ]
    `);
  });

  it("can encode and decode a file message (file-auth-message) with all fields", () => {
    const filePayload = {
      type: "file-auth-message" as const,
      permission: "denied" as const,
      fileId: "test-auth-id",
      statusCode: 403 as const,
      reason: "Access denied for test",
    };

    const originalMessage = new FileMessage<Record<string, unknown>>(
      "auth-doc",
      filePayload,
      { userId: "user-999" },
      false,
    );

    const decoded = decodeMessage(originalMessage.encoded);

    expect(decoded).toBeInstanceOf(FileMessage);
    expect(decoded.document).toBe("auth-doc");
    expect(decoded.encrypted).toBe(false);

    const payload = decoded.payload;
    if (payload.type !== "file-auth-message") {
      throw new Error("Expected payload type to be file-auth-message");
    }

    expect(payload.type).toBe(filePayload.type);
    expect(payload.permission).toBe(filePayload.permission);
    expect(payload.fileId).toBe(filePayload.fileId);
    expect(payload.statusCode).toBe(filePayload.statusCode);
    expect(payload.reason).toBe(filePayload.reason);
  });
});

describe("ping pong", () => {
  it("can encode and decode a ping message", () => {
    expect(encodePingMessage()).toMatchInlineSnapshot(`
      Uint8Array [
        89,
        74,
        83,
        112,
        105,
        110,
        103,
      ]
    `);
  });

  it("can encode and decode a pong message", () => {
    expect(encodePongMessage()).toMatchInlineSnapshot(`
      Uint8Array [
        89,
        74,
        83,
        112,
        111,
        110,
        103,
      ]
    `);
  });

  it("can detect a ping message", () => {
    expect(isPingMessage(encodePingMessage())).toBe(true);
  });

  it("can detect a pong message", () => {
    expect(isPongMessage(encodePongMessage())).toBe(true);
  });
});

describe("empty update", () => {
  it("can detect an empty update", () => {
    expect(isEmptyUpdate(getEmptyUpdate())).toBe(true);
  });

  it("can detect a non-empty update", () => {
    expect(
      isEmptyUpdate(new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update),
    ).toBe(false);
  });
});

describe("empty state vector", () => {
  it("can detect an empty state vector", () => {
    expect(isEmptyStateVector(getEmptyStateVector())).toBe(true);
  });

  it("can detect a non-empty state vector", () => {
    expect(
      isEmptyStateVector(
        new Uint8Array([0x00, 0x01, 0x02, 0x03]) as StateVector,
      ),
    ).toBe(false);
  });
});
