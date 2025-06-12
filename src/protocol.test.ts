import { describe, expect, it } from "bun:test";
import {
  AwarenessUpdateMessage,
  decodeUpdateMessage,
  encodeMessage,
  SendableAwarenessMessage,
  SendableDocMessage,
  StateVector,
  Update,
} from "./protocol";

describe("can encode and decode", () => {
  it("can encode and decode an awareness update", () => {
    expect(
      decodeUpdateMessage(
        encodeMessage(
          new SendableAwarenessMessage(
            "test",
            new Uint8Array([0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
          ),
        ),
      ),
    ).toMatchInlineSnapshot(`
      AwarenessMessage {
        "context": {},
        "document": "test",
        "type": "awareness",
        "update": Uint8Array [
          0,
          1,
          2,
          3,
        ],
      }
    `);
  });

  it("can encode and decode a doc update (sync step 1)", () => {
    expect(
      decodeUpdateMessage(
        encodeMessage(
          new SendableDocMessage("test", {
            type: "sync-step-1",
            payload: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as StateVector,
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "type": "doc",
        "update": Uint8Array [
          0,
          0,
          1,
          2,
          3,
        ],
      }
    `);
  });

  it("can encode and decode a doc update (sync step 2)", () => {
    expect(
      decodeUpdateMessage(
        encodeMessage(
          new SendableDocMessage("test", {
            type: "sync-step-2",
            payload: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "type": "doc",
        "update": Uint8Array [
          1,
          0,
          1,
          2,
          3,
        ],
      }
    `);
  });

  it("can encode and decode a doc update (update)", () => {
    expect(
      decodeUpdateMessage(
        encodeMessage(
          new SendableDocMessage("test", {
            type: "update",
            payload: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "type": "doc",
        "update": Uint8Array [
          2,
          0,
          1,
          2,
          3,
        ],
      }
    `);
  });
});

describe("can encode", () => {
  it("awareness update", () => {
    expect(
      encodeMessage(
        new SendableAwarenessMessage(
          "test",
          new Uint8Array([0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
        ),
      ),
    ).toMatchInlineSnapshot(`
      Uint8Array [
        89,
        74,
        83,
        1,
        4,
        116,
        101,
        115,
        116,
        1,
        0,
        1,
        2,
        3,
      ]
    `);
  });

  it("doc update (sync step 1)", () => {
    expect(
      encodeMessage(
        new SendableDocMessage("test", {
          type: "sync-step-1",
          payload: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as StateVector,
        }),
      ),
    ).toMatchInlineSnapshot(`
      Uint8Array [
        89,
        74,
        83,
        1,
        4,
        116,
        101,
        115,
        116,
        0,
        0,
        0,
        1,
        2,
        3,
      ]
    `);
  });

  it("doc update (sync step 2)", () => {
    expect(
      encodeMessage(
        new SendableDocMessage("test", {
          type: "sync-step-2",
          payload: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
        }),
      ),
    ).toMatchInlineSnapshot(`
      Uint8Array [
        89,
        74,
        83,
        1,
        4,
        116,
        101,
        115,
        116,
        0,
        1,
        0,
        1,
        2,
        3,
      ]
    `);
  });

  it("doc update (update)", () => {
    expect(
      encodeMessage(
        new SendableDocMessage("test", {
          type: "update",
          payload: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
        }),
      ),
    ).toMatchInlineSnapshot(`
      Uint8Array [
        89,
        74,
        83,
        1,
        4,
        116,
        101,
        115,
        116,
        0,
        2,
        0,
        1,
        2,
        3,
      ]
    `);
  });
});
