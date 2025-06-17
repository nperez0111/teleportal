import { describe, expect, it } from "bun:test";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { DocMessage, Update } from "../lib";
import { withPassthrough } from "./passthrough";
import { getYDocSink, getYDocSource, getYTransportFromYDoc } from "./ydoc";

describe("ydoc source", () => {
  it("can read a doc's updates", async () => {
    const doc = new Y.Doc();
    doc.clientID = 200;
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
    });

    doc.getText("test").insert(0, "hello");
    doc.getText("test").insert("hello".length - 1, " world");

    let count = 0;
    await source.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          expect(chunk.context.clientId).toBe("local");
          expect(chunk.type).toBe("doc");
          expect(chunk.document).toBe("test");
          if (count++ === 0) {
            expect(chunk.payload).toMatchInlineSnapshot(`
            {
              "type": "update",
              "update": Uint8Array [
                0,
                0,
                2,
                136,
                3,
                0,
                0,
                1,
                4,
                12,
                9,
                116,
                101,
                115,
                116,
                104,
                101,
                108,
                108,
                111,
                4,
                5,
                1,
                1,
                0,
                0,
                1,
                1,
                0,
                0,
              ],
            }
          `);
          } else {
            expect(chunk.payload).toMatchInlineSnapshot(`
              {
                "type": "update",
                "update": Uint8Array [
                  0,
                  0,
                  3,
                  200,
                  3,
                  1,
                  1,
                  6,
                  1,
                  8,
                  1,
                  196,
                  8,
                  6,
                  32,
                  119,
                  111,
                  114,
                  108,
                  100,
                  6,
                  0,
                  0,
                  0,
                  1,
                  1,
                  5,
                  0,
                ],
              }
            `);
            doc.destroy();
          }
        },
      }),
    );
  });

  it("can read a doc's awareness updates", async () => {
    const doc = new Y.Doc();
    doc.clientID = 200;
    const awareness = new Awareness(doc);
    const source = getYDocSource({
      ydoc: doc,
      awareness,
      document: "test",
    });

    awareness.setLocalState({
      test: "id-1",
    });

    awareness.destroy();

    await source.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          expect(chunk.context.clientId).toBe("local");
          expect(chunk.type).toBe("awareness");
          expect(chunk.document).toBe("test");
          expect(chunk.payload).toMatchInlineSnapshot(`
            {
              "type": "awareness-update",
              "update": Uint8Array [
                1,
                200,
                1,
                1,
                15,
                123,
                34,
                116,
                101,
                115,
                116,
                34,
                58,
                34,
                105,
                100,
                45,
                49,
                34,
                125,
              ],
            }
          `);
        },
      }),
    );
  });
});

describe("ydoc sink", () => {
  it("can write a doc's updates", async () => {
    const doc = new Y.Doc();
    doc.clientID = 300;
    const sink = getYDocSink({
      ydoc: doc,
      document: "test",
    });
    const writer = sink.writable.getWriter();

    await writer.write(
      new DocMessage(
        "test",
        {
          type: "update",
          update: new Uint8Array([
            0, 0, 2, 136, 3, 0, 0, 1, 4, 12, 9, 116, 101, 115, 116, 104, 101,
            108, 108, 111, 4, 5, 1, 1, 0, 0, 1, 1, 0, 0,
          ]) as Update,
        },
        {
          clientId: "200",
        },
      ),
    );

    expect(doc.getText("test").toString()).toBe("hello");

    await writer.write(
      new DocMessage(
        "test",
        {
          type: "update",
          update: new Uint8Array([
            0, 0, 3, 200, 3, 1, 1, 6, 1, 8, 1, 196, 8, 6, 32, 119, 111, 114,
            108, 100, 6, 0, 0, 0, 1, 1, 5, 0,
          ]) as Update,
        },
        {
          clientId: "200",
        },
      ),
    );

    expect(doc.getText("test").toString()).toBe("hell worldo");

    await writer.close();
  });

  // it("can write a doc's awareness updates", async () => {
  //   const doc = new Y.Doc();
  //   doc.clientID = 300;
  //   const awareness = new Awareness(doc);
  //   const sink = getSink({
  //     ydoc: doc,
  //     awareness,
  //     document: "test",
  //   });

  //   const writer = sink.awareness.writable.getWriter();

  //   await writer.write({
  //     type: "awareness",
  //     context: {
  //       clientId: 200,
  //     },
  //     document: "test",
  //     update: ,
  //   });
  // });
});

describe("ydoc transport", () => {
  it("can read a doc's updates", async () => {
    const doc = new Y.Doc();
    doc.clientID = 300;
    const transport = getYTransportFromYDoc({
      ydoc: doc,
      document: "test",
    });

    const reader = transport.readable.getReader();

    const writer = transport.writable.getWriter();

    await writer.write(
      new DocMessage(
        "test",
        {
          type: "update",
          update: new Uint8Array([
            0, 0, 2, 136, 3, 0, 0, 1, 4, 12, 9, 116, 101, 115, 116, 104, 101,
            108, 108, 111, 4, 5, 1, 1, 0, 0, 1, 1, 0, 0,
          ]) as Update,
        },
        {
          clientId: "200",
        },
      ),
    );

    doc.getText("test").insert("hello".length, " world");
    const { done, value } = await reader.read();
    if (!value) {
      throw new Error("No value");
    }
    expect(done).toBe(false);
    expect(value.context.clientId).toBe("local");
    expect(value.type).toBe("doc");
    expect(value.document).toBe("test");
    expect(value.payload).toMatchInlineSnapshot(`
      {
        "type": "update",
        "update": Uint8Array [
          0,
          0,
          4,
          172,
          4,
          136,
          3,
          1,
          8,
          0,
          1,
          132,
          8,
          6,
          32,
          119,
          111,
          114,
          108,
          100,
          6,
          0,
          0,
          0,
          1,
          1,
          0,
          0,
        ],
      }
    `);

    expect(doc.getText("test").toString()).toBe("hello world");
  });

  it("can be inspected with a passthrough", async () => {
    const doc = new Y.Doc();
    doc.clientID = 300;
    const transport = withPassthrough(
      getYTransportFromYDoc({
        ydoc: doc,
        document: "test",
      }),
      {
        onRead(chunk) {
          expect(chunk.encoded).toMatchInlineSnapshot(`
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
              28,
              0,
              0,
              4,
              172,
              4,
              136,
              3,
              1,
              8,
              0,
              1,
              132,
              8,
              6,
              32,
              119,
              111,
              114,
              108,
              100,
              6,
              0,
              0,
              0,
              1,
              1,
              0,
              0,
            ]
          `);
        },
        onWrite(chunk) {
          expect(chunk.encoded).toMatchInlineSnapshot(`
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
              30,
              0,
              0,
              2,
              136,
              3,
              0,
              0,
              1,
              4,
              12,
              9,
              116,
              101,
              115,
              116,
              104,
              101,
              108,
              108,
              111,
              4,
              5,
              1,
              1,
              0,
              0,
              1,
              1,
              0,
              0,
            ]
          `);
        },
      },
    );

    const reader = transport.readable.getReader();

    const writer = transport.writable.getWriter();

    await writer.write(
      new DocMessage(
        "test",
        {
          type: "update",
          update: new Uint8Array([
            0, 0, 2, 136, 3, 0, 0, 1, 4, 12, 9, 116, 101, 115, 116, 104, 101,
            108, 108, 111, 4, 5, 1, 1, 0, 0, 1, 1, 0, 0,
          ]) as Update,
        },
        {
          clientId: "200",
        },
      ),
    );

    doc.getText("test").insert("hello".length, " world");

    const { done, value } = await reader.read();
    expect(done).toBe(false);
    if (!value) {
      throw new Error("No value");
    }
    expect(value.context.clientId).toBe("local");
    expect(value.type).toBe("doc");
    expect(value.document).toBe("test");
    expect(value.payload).toMatchInlineSnapshot(`
      {
        "type": "update",
        "update": Uint8Array [
          0,
          0,
          4,
          172,
          4,
          136,
          3,
          1,
          8,
          0,
          1,
          132,
          8,
          6,
          32,
          119,
          111,
          114,
          108,
          100,
          6,
          0,
          0,
          0,
          1,
          1,
          0,
          0,
        ],
      }
    `);
  });
});
