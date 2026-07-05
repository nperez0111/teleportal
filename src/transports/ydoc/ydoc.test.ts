import { describe, expect, it } from "bun:test";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { DocMessage, type VersionedUpdate } from "teleportal";
import {
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
} from "teleportal/protocol/encryption";
import { withPassthrough } from "../passthrough";
import { getYDocSink, getYDocSource, getYTransportFromYDoc } from ".";

function wrapUpdate(v2: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: v2,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload } as unknown as VersionedUpdate;
}

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
    for await (const batch of source.source) {
      for (const chunk of batch) {
        expect(chunk.context.clientId).toBe("local");
        expect(chunk.type).toBe("doc");
        expect(chunk.document).toBe("test");
        const payload = chunk.payload as { type: string; update: VersionedUpdate };
        expect(payload.type).toBe("update");
        expect(payload.update.version).toBe(2);

        // Verify round-trip: decode envelope and apply V2 structure update
        const decoded = decodeContentEncryptedPayload(payload.update.data as any);
        expect(decoded.encryptedSidecars).toHaveLength(0);
        const verify = new Y.Doc();
        Y.applyUpdateV2(verify, decoded.structureUpdate);

        if (count++ === 0) {
          expect(verify.getText("test").toString()).toBe("hello");
        } else {
          // Second update applies on top of first
          doc.destroy();
        }
      }
    }
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

    for await (const batch of source.source) {
      for (const chunk of batch) {
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
      }
    }
  });
});

describe("ydoc source batching", () => {
  it("batches rapid updates into a single merged message", async () => {
    const doc = new Y.Doc();
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
      updateBatchIntervalMs: 1,
    });

    const messages: any[] = [];
    const done = (async () => {
      for await (const batch of source.source) {
        for (const chunk of batch) {
          messages.push(chunk);
        }
      }
    })();

    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(1, "b");
    doc.getText("t").insert(2, "c");

    // Wait for the batch to flush, then destroy to close the stream
    await new Promise((r) => setTimeout(r, 5));
    doc.destroy();
    await done;

    // All three edits collapsed into one message
    expect(messages.length).toBe(1);
    const payload = messages[0].payload as { type: string; update: VersionedUpdate };
    expect(payload.type).toBe("update");
    expect(payload.update.version).toBe(2);

    // Decode the content-encrypted envelope and verify the V2 structure update
    const decoded = decodeContentEncryptedPayload(payload.update.data as any);
    expect(decoded.encryptedSidecars).toHaveLength(0);
    const verify = new Y.Doc();
    Y.applyUpdateV2(verify, decoded.structureUpdate);
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
    const done = (async () => {
      for await (const batch of source.source) {
        for (const chunk of batch) {
          messages.push(chunk);
        }
      }
    })();

    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(1, "b");

    doc.destroy();
    await done;

    expect(messages.length).toBe(2);
    expect((messages[0].payload as any).update.version).toBe(2);
    expect((messages[1].payload as any).update.version).toBe(2);
  });

  it("flushes pending updates on destroy", async () => {
    const doc = new Y.Doc();
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
      updateBatchIntervalMs: 5000, // long timer — won't fire naturally
    });

    const messages: any[] = [];
    const done = (async () => {
      for await (const batch of source.source) {
        for (const chunk of batch) {
          messages.push(chunk);
        }
      }
    })();

    doc.getText("t").insert(0, "hello");

    // Destroy before the batch timer fires — should still flush
    doc.destroy();
    await done;

    expect(messages.length).toBe(1);
    const payload = messages[0].payload as { type: string; update: VersionedUpdate };
    const decoded = decodeContentEncryptedPayload(payload.update.data as any);
    const verify = new Y.Doc();
    Y.applyUpdateV2(verify, decoded.structureUpdate);
    expect(verify.getText("t").toString()).toBe("hello");
  });

  it("emits separate messages for updates across different batch windows", async () => {
    const doc = new Y.Doc();
    const source = getYDocSource({
      ydoc: doc,
      document: "test",
      updateBatchIntervalMs: 1,
    });

    const messages: any[] = [];
    const done = (async () => {
      for await (const batch of source.source) {
        for (const chunk of batch) {
          messages.push(chunk);
        }
      }
    })();

    // First batch
    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(1, "b");
    await new Promise((r) => setTimeout(r, 5));

    // Second batch
    doc.getText("t").insert(2, "c");
    await new Promise((r) => setTimeout(r, 5));

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

    // Create first update: insert "hello" into text "test"
    const srcDoc1 = new Y.Doc();
    srcDoc1.clientID = 200;
    srcDoc1.getText("test").insert(0, "hello");
    const update1 = Y.encodeStateAsUpdateV2(srcDoc1);

    await sink.write(
      new DocMessage("test", { type: "update", update: wrapUpdate(update1) }, { clientId: "200" }),
    );

    expect(doc.getText("test").toString()).toBe("hello");

    // Create second update: insert " world" at position 4
    const srcDoc2 = new Y.Doc();
    srcDoc2.clientID = 200;
    Y.applyUpdateV2(srcDoc2, update1);
    srcDoc2.getText("test").insert(4, " world");
    const update2 = Y.encodeStateAsUpdateV2(srcDoc2, Y.encodeStateVector(srcDoc1));

    await sink.write(
      new DocMessage("test", { type: "update", update: wrapUpdate(update2) }, { clientId: "200" }),
    );

    expect(doc.getText("test").toString()).toBe("hell worldo");

    await sink.write(new DocMessage("test", { type: "sync-done" }, { clientId: "200" }));

    await sink.synced;
    sink.close();
  });

  it("does not emit an unhandled rejection when closed before sync without awaiting synced", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const doc = new Y.Doc();
      const sink = getYDocSink({ ydoc: doc, document: "test" });
      // Intentionally never await `sink.synced` — mirrors a provider that is
      // destroyed (e.g. switchDocument) before anyone consumes the promise.
      sink.close();
      // Drain microtasks + a macrotask so any unhandled rejection is reported.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const cancelled = rejections.filter(
        (r) => r instanceof Error && r.message === "YDoc cancelled",
      );
      expect(cancelled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

});

describe("ydoc transport", () => {
  it("can read a doc's updates", async () => {
    const doc = new Y.Doc();
    doc.clientID = 300;
    const transport = getYTransportFromYDoc({
      ydoc: doc,
      document: "test",
    });

    const iter = transport.source[Symbol.asyncIterator]();

    // Create a programmatic update for "hello" in text "test"
    const srcDoc = new Y.Doc();
    srcDoc.clientID = 200;
    srcDoc.getText("test").insert(0, "hello");
    const helloUpdate = Y.encodeStateAsUpdateV2(srcDoc);

    await transport.write(
      new DocMessage(
        "test",
        {
          type: "update",
          update: wrapUpdate(helloUpdate),
        },
        {
          clientId: "200",
        },
      ),
    );

    doc.getText("test").insert("hello".length, " world");
    const { value: batch } = await iter.next();
    const value = batch[0];
    if (!value) {
      throw new Error("No value");
    }
    expect(value.context.clientId).toBe("local");
    expect(value.type).toBe("doc");
    expect(value.document).toBe("test");

    // Verify output is content-encrypted envelope
    const payload = value.payload as { type: string; update: VersionedUpdate };
    expect(payload.type).toBe("update");
    expect(payload.update.version).toBe(2);
    const decoded = decodeContentEncryptedPayload(payload.update.data as any);
    expect(decoded.encryptedSidecars).toHaveLength(0);
    // Apply structure update to verify content
    const verify = new Y.Doc();
    Y.applyUpdateV2(verify, helloUpdate); // apply base first
    Y.applyUpdateV2(verify, decoded.structureUpdate);
    expect(verify.getText("test").toString()).toBe("hello world");

    expect(doc.getText("test").toString()).toBe("hello world");
  });

  it("can be inspected with a passthrough", async () => {
    const doc = new Y.Doc();
    doc.clientID = 300;

    // Create a programmatic update for "hello" in text "test"
    const srcDoc = new Y.Doc();
    srcDoc.clientID = 200;
    srcDoc.getText("test").insert(0, "hello");
    const helloUpdate = Y.encodeStateAsUpdateV2(srcDoc);

    let readCalled = false;
    let writeCalled = false;
    const transport = withPassthrough(
      getYTransportFromYDoc({
        ydoc: doc,
        document: "test",
      }),
      {
        onRead(chunk) {
          readCalled = true;
          expect(chunk.type).toBe("doc");
        },
        onWrite(chunk) {
          writeCalled = true;
          expect(chunk.type).toBe("doc");
        },
      },
    );

    const iter = transport.source[Symbol.asyncIterator]();

    await transport.write(
      new DocMessage(
        "test",
        {
          type: "update",
          update: wrapUpdate(helloUpdate),
        },
        {
          clientId: "200",
        },
      ),
    );

    doc.getText("test").insert("hello".length, " world");

    const { value: batch } = await iter.next();
    const value = batch[0];
    if (!value) {
      throw new Error("No value");
    }
    expect(value.context.clientId).toBe("local");
    expect(value.type).toBe("doc");
    expect(value.document).toBe("test");

    // Verify output is content-encrypted envelope
    const payload = value.payload as { type: string; update: VersionedUpdate };
    expect(payload.type).toBe("update");
    expect(payload.update.version).toBe(2);
    const decoded = decodeContentEncryptedPayload(payload.update.data as any);
    expect(decoded.encryptedSidecars).toHaveLength(0);

    expect(readCalled).toBe(true);
    expect(writeCalled).toBe(true);
  });
});
