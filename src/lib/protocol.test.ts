import { describe, expect, it } from "bun:test";
import {
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
  Update,
} from "./protocol";

describe("can encode and decode", () => {
  it("can encode and decode an awareness update", () => {
    expect(
      Object.assign(
        decodeMessage(
          new AwarenessMessage("test", {
            type: "awareness-update",
            update: new Uint8Array([
              0x00, 0x01, 0x02, 0x03,
            ]) as AwarenessUpdateMessage,
          }).encoded,
        ),
        {
          id: "abc",
        },
      ),
    ).toMatchInlineSnapshot(`
      AwarenessMessage {
        "context": {},
        "document": "test",
        "id": "abc",
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
      Object.assign(
        decodeMessage(
          new DocMessage("test", {
            type: "sync-step-1",
            sv: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as StateVector,
          }).encoded,
        ),
        {
          id: "abc",
        },
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "id": "abc",
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
      Object.assign(
        decodeMessage(
          new DocMessage("test", {
            type: "sync-step-2",
            update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
          }).encoded,
        ),
        {
          id: "abc",
        },
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "id": "abc",
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

  it("can encode and decode a doc update (update)", () => {
    expect(
      Object.assign(
        decodeMessage(
          new DocMessage("test", {
            type: "update",
            update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
          }).encoded,
        ),
        {
          id: "abc",
        },
      ),
    ).toMatchInlineSnapshot(`
      DocMessage {
        "context": {},
        "document": "test",
        "id": "abc",
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
});

describe("can encode", () => {
  it("awareness update", () => {
    expect(
      new AwarenessMessage("test", {
        type: "awareness-update",
        update: new Uint8Array([
          0x00, 0x01, 0x02, 0x03,
        ]) as AwarenessUpdateMessage,
      }).encoded,
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
        4,
        0,
        1,
        2,
        3,
      ]
    `);
  });

  it("doc update (sync step 1)", () => {
    expect(
      new DocMessage("test", {
        type: "sync-step-1",
        sv: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as StateVector,
      }).encoded,
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
        4,
        0,
        1,
        2,
        3,
      ]
    `);
  });

  it("doc update (sync step 2)", () => {
    expect(
      new DocMessage("test", {
        type: "sync-step-2",
        update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
      }).encoded,
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
        4,
        0,
        1,
        2,
        3,
      ]
    `);
  });

  it("doc update (update)", () => {
    expect(
      new DocMessage("test", {
        type: "update",
        update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as Update,
      }).encoded,
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
        4,
        0,
        1,
        2,
        3,
      ]
    `);
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
        103,
        110,
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
