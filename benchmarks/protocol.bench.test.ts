import { describe, it } from "bun:test";
import * as Y from "yjs";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  getEmptyContentEncryptedPayload,
} from "../src/lib/protocol/encryption/encoding";
import { createEncryptionKey } from "../src/encryption-key";
import { EncryptionClient } from "../src/transports/encrypted";
import { bench, createLargeDoc, formatBytes } from "./helpers";

describe("Protocol Benchmarks", () => {
  describe("Content Encrypted Payload encoding", () => {
    it("encode - empty payload", async () => {
      await bench(
        "encode empty payload",
        () => { getEmptyContentEncryptedPayload(); },
        { iterations: 5000 },
      );
    });

    it("encode - small payload", async () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "hello world");
      const update = Y.encodeStateAsUpdateV2(doc);

      await bench(
        "encode small payload",
        () => {
          encodeContentEncryptedPayload({
            structureUpdate: update,
            encryptedSidecars: [],
          });
        },
        { iterations: 2000 },
      );
    });

    it("encode - payload with sidecars", async () => {
      const doc = createLargeDoc(5_000);
      const update = Y.encodeStateAsUpdateV2(doc);
      const sidecar = new Uint8Array(1024);
      crypto.getRandomValues(sidecar);

      await bench(
        "encode payload with 1 sidecar",
        () => {
          encodeContentEncryptedPayload({
            structureUpdate: update,
            encryptedSidecars: [sidecar],
          });
        },
        { iterations: 500 },
      );
    });

    it("decode - round trip", async () => {
      const doc = createLargeDoc(1_000);
      const update = Y.encodeStateAsUpdateV2(doc);
      const encoded = encodeContentEncryptedPayload({
        structureUpdate: update,
        encryptedSidecars: [],
      });
      console.log(`    encoded size: ${formatBytes(encoded.byteLength)}`);

      await bench(
        "decode payload (1K chars)",
        () => { decodeContentEncryptedPayload(encoded); },
        { iterations: 2000 },
      );
    });

    it("encode+decode throughput - various sizes", async () => {
      for (const size of [100, 1_000, 10_000]) {
        const doc = createLargeDoc(size);
        const update = Y.encodeStateAsUpdateV2(doc);

        await bench(
          `encode+decode (${size} chars)`,
          () => {
            const encoded = encodeContentEncryptedPayload({
              structureUpdate: update,
              encryptedSidecars: [],
            });
            decodeContentEncryptedPayload(encoded);
          },
          { iterations: size > 5_000 ? 100 : 500 },
        );
      }
    });
  });

  describe("Encryption", () => {
    it("createEncryptionKey", async () => {
      await bench(
        "createEncryptionKey",
        () => createEncryptionKey(),
        { iterations: 200 },
      );
    });

    it("EncryptionClient - encrypt small update", async () => {
      const key = await createEncryptionKey();
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "hello");

      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: null as any,
        key,
      });

      const update = Y.encodeStateAsUpdateV2(doc);

      await bench(
        "encrypt small update",
        async () => {
          await client.encryptUpdate(update);
        },
        { iterations: 500 },
      );
    });

    it("EncryptionClient - encrypt large update", async () => {
      const key = await createEncryptionKey();
      const doc = createLargeDoc(10_000);

      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: null as any,
        key,
      });

      const update = Y.encodeStateAsUpdateV2(doc);
      console.log(`    update size: ${formatBytes(update.byteLength)}`);

      await bench(
        "encrypt large update (10K chars)",
        async () => {
          await client.encryptUpdate(update);
        },
        { iterations: 100 },
      );
    });

    it("EncryptionClient - encrypt + decrypt round trip", async () => {
      const key = await createEncryptionKey();
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "benchmark content");

      const client = new EncryptionClient({
        document: "bench-doc",
        ydoc: doc,
        awareness: null as any,
        key,
      });

      const update = Y.encodeStateAsUpdateV2(doc);

      await bench(
        "encrypt + decrypt round trip",
        async () => {
          const encrypted = await client.encryptUpdate(update);
          await client.decryptUpdate(encrypted);
        },
        { iterations: 200 },
      );
    });
  });
});
