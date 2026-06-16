import { describe, expect, it } from "bun:test";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { DocMessage, Update, type VersionedUpdate } from "teleportal";
import { applyVersionedUpdate } from "teleportal/protocol";
import { withPassthrough } from "../passthrough";
import { getYDocSink, getYDocSource, getYTransportFromYDoc } from ".";

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
              "update": {
                "data": Uint8Array [
                  1,
                  1,
                  200,
                  1,
                  0,
                  4,
                  1,
                  4,
                  116,
                  101,
                  115,
                  116,
                  5,
                  104,
                  101,
                  108,
                  108,
                  111,
                  0,
                ],
                "version": 1,
              },
            }
          `);
          } else {
            expect(chunk.payload).toMatchInlineSnapshot(`
              {
                "type": "update",
                "update": {
                  "data": Uint8Array [
                    1,
                    1,
                    200,
                    1,
                    5,
                    196,
                    200,
                    1,
                    3,
                    200,
                    1,
                    4,
                    6,
                    32,
                    119,
                    111,
                    114,
                    108,
                    100,
                    0,
                  ],
                  "version": 1,
                },
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

    await new Promise((resolve) => setTimeout(resolve, 0));
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

describe("ydoc source batching", () => {
  it("batches rapid updates into a single merged message", async () => {
    const doc = new Y.Doc();
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
      updateBatchIntervalMs: 20,
    });

    const messages: any[] = [];
    const done = source.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          messages.push(chunk);
        },
      }),
    );

    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(1, "b");
    doc.getText("t").insert(2, "c");

    // Wait for the batch to flush, then destroy to close the stream
    await new Promise((r) => setTimeout(r, 50));
    doc.destroy();
    await done;

    // All three edits collapsed into one message
    expect(messages.length).toBe(1);
    const payload = messages[0].payload as { type: string; update: VersionedUpdate };
    expect(payload.type).toBe("update");
    expect(payload.update.version).toBe(2);

    const verify = new Y.Doc();
    applyVersionedUpdate(verify, payload.update);
    expect(verify.getText("t").toString()).toBe("abc");
  });

  it("does not batch when updateBatchIntervalMs is 0", async () => {
    const doc = new Y.Doc();
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
      updateBatchIntervalMs: 0,
    });

    const messages: any[] = [];
    const done = source.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          messages.push(chunk);
        },
      }),
    );

    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(1, "b");

    doc.destroy();
    await done;

    expect(messages.length).toBe(2);
    expect((messages[0].payload as any).update.version).toBe(1);
    expect((messages[1].payload as any).update.version).toBe(1);
  });

  it("flushes pending updates on destroy", async () => {
    const doc = new Y.Doc();
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
      updateBatchIntervalMs: 5000, // long timer — won't fire naturally
    });

    const messages: any[] = [];
    const done = source.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          messages.push(chunk);
        },
      }),
    );

    doc.getText("t").insert(0, "hello");

    // Destroy before the batch timer fires — should still flush
    doc.destroy();
    await done;

    expect(messages.length).toBe(1);
    const payload = messages[0].payload as { type: string; update: VersionedUpdate };
    const verify = new Y.Doc();
    applyVersionedUpdate(verify, payload.update);
    expect(verify.getText("t").toString()).toBe("hello");
  });

  it("emits separate messages for updates across different batch windows", async () => {
    const doc = new Y.Doc();
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
      updateBatchIntervalMs: 10,
    });

    const messages: any[] = [];
    const done = source.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          messages.push(chunk);
        },
      }),
    );

    // First batch
    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(1, "b");
    await new Promise((r) => setTimeout(r, 30));

    // Second batch
    doc.getText("t").insert(2, "c");
    await new Promise((r) => setTimeout(r, 30));

    doc.destroy();
    await done;

    expect(messages.length).toBe(2);
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
          update: {
            version: 2,
            data: new Uint8Array([
              0, 0, 2, 136, 3, 0, 0, 1, 4, 12, 9, 116, 101, 115, 116, 104, 101, 108, 108, 111, 4, 5,
              1, 1, 0, 0, 1, 1, 0, 0,
            ]) as Update,
          } as VersionedUpdate,
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
          update: {
            version: 2,
            data: new Uint8Array([
              0, 0, 3, 200, 3, 1, 1, 6, 1, 8, 1, 196, 8, 6, 32, 119, 111, 114, 108, 100, 6, 0, 0, 0,
              1, 1, 5, 0,
            ]) as Update,
          } as VersionedUpdate,
        },
        {
          clientId: "200",
        },
      ),
    );

    expect(doc.getText("test").toString()).toBe("hell worldo");

    // Send sync-done message to resolve the synced promise
    await writer.write(
      new DocMessage(
        "test",
        {
          type: "sync-done",
        },
        {
          clientId: "200",
        },
      ),
    );

    // Wait for the synced promise to resolve
    await sink.synced;

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
          update: {
            version: 2,
            data: new Uint8Array([
              0, 0, 2, 136, 3, 0, 0, 1, 4, 12, 9, 116, 101, 115, 116, 104, 101, 108, 108, 111, 4, 5,
              1, 1, 0, 0, 1, 1, 0, 0,
            ]) as Update,
          } as VersionedUpdate,
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
        "update": {
          "data": Uint8Array [
            1,
            1,
            172,
            2,
            0,
            132,
            200,
            1,
            4,
            6,
            32,
            119,
            111,
            114,
            108,
            100,
            0,
          ],
          "version": 1,
        },
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
              0,
              2,
              1,
              17,
              1,
              1,
              172,
              2,
              0,
              132,
              200,
              1,
              4,
              6,
              32,
              119,
              111,
              114,
              108,
              100,
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
              0,
              2,
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
          update: {
            version: 2,
            data: new Uint8Array([
              0, 0, 2, 136, 3, 0, 0, 1, 4, 12, 9, 116, 101, 115, 116, 104, 101, 108, 108, 111, 4, 5,
              1, 1, 0, 0, 1, 1, 0, 0,
            ]) as Update,
          } as VersionedUpdate,
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
        "update": {
          "data": Uint8Array [
            1,
            1,
            172,
            2,
            0,
            132,
            200,
            1,
            4,
            6,
            32,
            119,
            111,
            114,
            108,
            100,
            0,
          ],
          "version": 1,
        },
      }
    `);
  });
});
