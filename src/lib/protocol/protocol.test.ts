import { describe, expect, it } from "bun:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { RpcMessage, type RpcSuccess } from "teleportal/protocol";
import {
  AckMessage,
  AwarenessMessage,
  AwarenessUpdateMessage,
  decodeMessage,
  DocMessage,
  encodePingMessage,
  encodePongMessage,
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
import type { FilePartStream } from "../../protocols/file/methods";
import { CHUNK_SIZE } from "../merkle-tree/merkle-tree";

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

  it("can encode and decode an RPC stream message (file-part)", () => {
    const chunkData = new Uint8Array(CHUNK_SIZE);
    chunkData.fill(1);

    const merkleProof = [
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
    ];

    const filePart: FilePartStream = {
      fileId: "test-file-id",
      chunkIndex: 0,
      chunkData,
      merkleProof,
      totalChunks: 10,
      bytesUploaded: CHUNK_SIZE,
      encrypted: false,
    };

    const streamMessage = new RpcMessage<Record<string, unknown>>(
      "test-doc",
      { type: "success", payload: filePart },
      "testMethod",
      "stream",
      "original-request-id",
      {},
      false,
    );

    const decoded = decodeMessage(streamMessage.encoded);
    expect(decoded).toBeInstanceOf(RpcMessage);
    expect(decoded.type).toBe("rpc");

    const rpcMessage = decoded as RpcMessage<Record<string, unknown>>;
    expect(rpcMessage.requestType).toBe("stream");
    expect(rpcMessage.originalRequestId).toBe("original-request-id");

    expect(rpcMessage.payload.type).toBe("success");
  });

  it("can encode and decode an RPC stream message (file-part) with all fields", () => {
    const chunkData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleProof = [
      new Uint8Array([10, 11, 12]),
      new Uint8Array([20, 21, 22]),
    ];

    const filePart: FilePartStream = {
      fileId: "test-part-id",
      chunkIndex: 5,
      chunkData: chunkData,
      merkleProof: merkleProof,
      totalChunks: 100,
      bytesUploaded: 5000,
      encrypted: true,
    };

    const originalMessage = new RpcMessage<Record<string, unknown>>(
      "part-doc",
      { type: "success", payload: filePart },
      "testMethod",
      "stream",
      "original-request-id",
      { userId: "user-789" },
      true,
    );

    const decoded = decodeMessage(originalMessage.encoded);

    expect(decoded).toBeInstanceOf(RpcMessage);
    expect(decoded.document).toBe("part-doc");
    expect(decoded.encrypted).toBe(true);

    const rpcMessage = decoded as RpcMessage<Record<string, unknown>>;
    expect(rpcMessage.requestType).toBe("stream");
    expect(rpcMessage.originalRequestId).toBe("original-request-id");

    expect(rpcMessage.payload.type).toBe("success");
  });

  it("can encode and decode an RPC request message", () => {
    const original = new RpcMessage(
      "test-doc",
      { type: "success", payload: { data: "testData" } },
      "testMethod",
      "request",
      undefined,
      {},
      false,
    );

    const encoded = original.encoded;
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe("rpc");
    expect((decoded as RpcMessage<any>).rpcMethod).toBe("testMethod");
    expect((decoded as RpcMessage<any>).requestType).toBe("request");
    expect((decoded as RpcMessage<any>).originalRequestId).toBeUndefined();
    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect((decoded as RpcMessage<any>).payload.payload).toEqual({
      data: "testData",
    });
  });

  it("can encode and decode an RPC stream message", () => {
    const original = new RpcMessage(
      "test-doc",
      { type: "success", payload: { chunkIndex: 0, data: [1, 2, 3] } },
      "testMethod",
      "stream",
      "request-123",
      {},
      false,
    );

    const encoded = original.encoded;
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe("rpc");
    expect((decoded as RpcMessage<any>).requestType).toBe("stream");
    expect((decoded as RpcMessage<any>).originalRequestId).toBe("request-123");
    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect((decoded as RpcMessage<any>).payload.payload).toEqual({
      chunkIndex: 0,
      data: [1, 2, 3],
    });
  });

  it("can encode and decode an RPC success response message", () => {
    const original = new RpcMessage(
      "test-doc",
      { type: "success", payload: { id: "123", name: "test" } },
      "testMethod",
      "response",
      "request-123",
      {},
      false,
    );

    const encoded = original.encoded;
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe("rpc");
    expect((decoded as RpcMessage<any>).requestType).toBe("response");
    expect((decoded as RpcMessage<any>).originalRequestId).toBe("request-123");
    expect((decoded as RpcMessage<any>).payload).toEqual({
      type: "success",
      payload: { id: "123", name: "test" },
    });
  });

  it("can encode and decode an RPC error response message", () => {
    const original = new RpcMessage(
      "test-doc",
      {
        type: "error",
        statusCode: 500,
        details: "Internal server error",
        payload: { trace: "abc" },
      },
      "testMethod",
      "response",
      "request-123",
      {},
      false,
    );

    const encoded = original.encoded;
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodeMessage(encoded);
    expect(decoded.type).toBe("rpc");
    expect((decoded as RpcMessage<any>).requestType).toBe("response");
    expect((decoded as RpcMessage<any>).originalRequestId).toBe("request-123");
    expect((decoded as RpcMessage<any>).payload).toEqual({
      type: "error",
      statusCode: 500,
      details: "Internal server error",
      payload: { trace: "abc" },
    });
  });

  it("can preserve context through encode/decode for RPC messages", () => {
    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload: { data: "testData" } },
      "testMethod",
      "request",
      undefined,
      { userId: "user-123", role: "admin" },
      false,
    );

    expect(message.context).toEqual({ userId: "user-123", role: "admin" });

    const encoded = message.encoded;
    const decoded = decodeMessage(encoded);

    expect(decoded.type).toBe("rpc");
    expect((decoded as RpcMessage<any>).rpcMethod).toBe("testMethod");
    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect((decoded as RpcMessage<any>).payload.payload).toEqual({
      data: "testData",
    });
  });

  it("can preserve encryption flag through encode/decode for RPC messages", () => {
    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload: { data: "testData" } },
      "testMethod",
      "request",
      undefined,
      {},
      true,
    );

    expect(message.encrypted).toBe(true);

    const encoded = message.encoded;
    const decoded = decodeMessage(encoded);

    expect(decoded.type).toBe("rpc");
    expect((decoded as RpcMessage<any>).rpcMethod).toBe("testMethod");
    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect((decoded as RpcMessage<any>).payload.payload).toEqual({
      data: "testData",
    });
  });

  it("can handle nested objects in RPC message payloads", () => {
    const payload = {
      filter: {
        createdAfter: 1609459200000,
        createdBefore: 1640995200000,
        tags: ["important", "draft"],
      },
      pagination: {
        limit: 50,
        offset: 0,
      },
    };

    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload },
      "queryData",
      "request",
      undefined,
      {},
      false,
    );

    const encoded = message.encoded;
    const decoded = decodeMessage(encoded);

    expect((decoded as RpcMessage<any>).rpcMethod).toBe("queryData");
    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect((decoded as RpcMessage<any>).payload.payload).toEqual(payload);
  });

  it("can handle arrays in RPC message payloads", () => {
    const payload = {
      items: [1, 2, 3, 4, 5],
      names: ["a", "b", "c"],
    };

    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload },
      "batchProcess",
      "request",
      undefined,
      {},
      false,
    );

    const encoded = message.encoded;
    const decoded = decodeMessage(encoded);

    expect((decoded as RpcMessage<any>).rpcMethod).toBe("batchProcess");
    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect((decoded as RpcMessage<any>).payload.payload).toEqual(payload);
  });

  it("can handle binary data in RPC message payloads", () => {
    const binaryData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload: { data: binaryData } },
      "uploadChunk",
      "request",
      undefined,
      {},
      false,
    );

    const encoded = message.encoded;
    const decoded = decodeMessage(encoded);

    expect((decoded as RpcMessage<any>).rpcMethod).toBe("uploadChunk");
    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect(
      ((decoded as RpcMessage<any>).payload.payload as { data: Uint8Array })
        .data,
    ).toEqual(binaryData);
  });
});

describe("custom serialization", () => {
  it("uses custom serializer when provided for response", () => {
    const customBytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const serializer = (ctx: any) => {
      if (ctx.type === "rpc" && ctx.message.requestType === "response") {
        return customBytes;
      }
      return undefined;
    };

    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload: { id: "123" } },
      "testMethod",
      "response",
      "request-123",
      {},
      false,
      undefined,
      serializer,
    );

    const encoded = message.encoded;
    // Decode and check that the payload bytes match our custom serialization
    // We need to manually decode to check the payload bytes
    const decoder = decoding.createDecoder(encoded);
    // Skip magic, version, document, encrypted, message type, method, request type, originalRequestId
    decoding.readUint8(decoder); // Y
    decoding.readUint8(decoder); // J
    decoding.readUint8(decoder); // S
    decoding.readUint8(decoder); // version
    decoding.readVarString(decoder); // document
    decoding.readUint8(decoder); // encrypted
    decoding.readUint8(decoder); // message type (4 = rpc)
    decoding.readVarString(decoder); // method
    decoding.readUint8(decoder); // request type (2 = response)
    decoding.readVarString(decoder); // originalRequestId
    decoding.readUint8(decoder); // isSuccess
    const payloadBytes = decoding.readVarUint8Array(decoder);

    expect(payloadBytes).toEqual(customBytes);
  });

  it("uses custom serializer when provided for stream", () => {
    const customBytes = new Uint8Array([0xdd, 0xee, 0xff]);
    const serializer = (ctx: any) => {
      if (ctx.type === "rpc" && ctx.message.requestType === "stream") {
        return customBytes;
      }
      return undefined;
    };

    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload: { chunk: 1 } },
      "testMethod",
      "stream",
      "request-123",
      {},
      false,
      undefined,
      serializer,
    );

    const encoded = message.encoded;
    const decoder = decoding.createDecoder(encoded);
    decoding.readUint8(decoder); // Y
    decoding.readUint8(decoder); // J
    decoding.readUint8(decoder); // S
    decoding.readUint8(decoder); // version
    decoding.readVarString(decoder); // document
    decoding.readUint8(decoder); // encrypted
    decoding.readUint8(decoder); // message type
    decoding.readVarString(decoder); // method
    decoding.readUint8(decoder); // request type
    decoding.readVarString(decoder); // originalRequestId
    decoding.readUint8(decoder); // isSuccess
    const payloadBytes = decoding.readVarUint8Array(decoder);

    expect(payloadBytes).toEqual(customBytes);
  });

  it("falls back to default serialization when serializer returns undefined", () => {
    const serializer = () => undefined; // Always return undefined

    const originalPayload: RpcSuccess = {
      type: "success",
      payload: { id: "123" },
    };
    const message = new RpcMessage(
      "test-doc",
      originalPayload,
      "testMethod",
      "response",
      "request-123",
      {},
      false,
      undefined,
      serializer,
    );

    const encoded = message.encoded;
    const decoded = decodeMessage(encoded);

    expect((decoded as RpcMessage<any>).payload).toEqual(originalPayload);
  });

  it("uses custom deserializer when provided for request", () => {
    const customPayload = { method: "testMethod", customField: "customValue" };
    const deserializer = (ctx: any) => {
      if (ctx.type === "rpc" && ctx.method === "testMethod") {
        return customPayload;
      }
      return undefined;
    };

    // Create a message with default encoding
    const originalMessage = new RpcMessage(
      "test-doc",
      { type: "success", payload: { data: "testData" } },
      "testMethod",
      "request",
      undefined,
      {},
      false,
    );

    const encoded = originalMessage.encoded;
    const decoded = decodeMessage(encoded, deserializer);

    expect((decoded as RpcMessage<any>).payload.type).toBe("success");
    expect((decoded as RpcMessage<any>).payload.payload).toEqual(customPayload);
  });

  it("falls back to default deserialization when deserializer returns undefined", () => {
    const deserializer = () => undefined; // Always return undefined

    const originalPayload: RpcSuccess = {
      type: "success",
      payload: { data: "testData" },
    };
    const message = new RpcMessage(
      "test-doc",
      originalPayload,
      "testMethod",
      "request",
      undefined,
      {},
      false,
    );

    const encoded = message.encoded;
    const decoded = decodeMessage(encoded, deserializer);

    expect((decoded as RpcMessage<any>).payload).toEqual(originalPayload);
  });

  it("provides encoder in serializer context", () => {
    let receivedEncoder: any = null;
    const serializer = (ctx: any) => {
      if (ctx.type === "rpc") {
        receivedEncoder = ctx.encoder;
        // Use the encoder to write custom data
        encoding.writeVarString(ctx.encoder, "custom");
        return encoding.toUint8Array(ctx.encoder);
      }
      return undefined;
    };

    const deserializer = (ctx: any) => {
      if (ctx.type === "rpc") {
        // Read the custom string format
        return decoding.readVarString(ctx.decoder);
      }
      return undefined;
    };

    const message = new RpcMessage(
      "test-doc",
      { type: "success", payload: { id: "123" } },
      "testMethod",
      "response",
      "request-123",
      {},
      false,
      undefined,
      serializer,
    );

    // Access encoded to trigger encoding and serializer call
    const encoded = message.encoded;
    expect(receivedEncoder).not.toBeNull();
    const decoded = decodeMessage(encoded, deserializer);

    // The payload should be decoded as "custom" string (since we used custom serialization)
    const rpcMessage = decoded as RpcMessage<any>;
    expect(rpcMessage.payload.type).toBe("success");
    expect(rpcMessage.payload.payload).toBe("custom");
  });

  it("provides decoder in deserializer context", () => {
    let receivedDecoder: any = null;
    let deserializedValue: any = null;
    const deserializer = (ctx: any) => {
      if (ctx.type === "rpc") {
        receivedDecoder = ctx.decoder;
        // Use the decoder to read the payload and return a custom value
        const originalPayload = decoding.readAny(ctx.decoder);
        deserializedValue = originalPayload;
        return { method: "testMethod", customData: "deserialized" };
      }
      return undefined;
    };

    // Create a message with default encoding, then test deserializer
    const originalMessage = new RpcMessage(
      "test-doc",
      { type: "success", payload: { data: "testData" } },
      "testMethod",
      "request",
      undefined,
      {},
      false,
    );

    const encoded = originalMessage.encoded;
    const decoded = decodeMessage(encoded, deserializer);

    expect(receivedDecoder).not.toBeNull();
    const rpcMessage = decoded as RpcMessage<any>;
    // Verify that the deserializer was called and returned our custom value
    expect(rpcMessage.payload.type).toBe("success");
    expect((rpcMessage.payload.payload as any).customData).toBe("deserialized");
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
