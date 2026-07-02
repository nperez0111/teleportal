import { describe, it } from "bun:test";
import * as Y from "yjs";
import {
  stripContent,
  restoreContent,
  gcSidecar,
  mergeSidecars,
  encodeSidecar,
  decodeSidecar,
} from "../src/lib/protocol/encryption/content-cipher";
import { bench, formatBytes } from "./helpers";

function v1(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function makeSmallDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.getText("t").insert(0, "Hello World");
  doc.getText("t").format(0, 5, { bold: true });
  return doc;
}

function makeMediumDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const text = doc.getText("body");
  for (let i = 0; i < 20; i++) {
    text.insert(text.length, `Sentence ${i}. `);
  }
  text.format(0, 10, { bold: true });
  text.format(20, 10, { italic: true });
  const map = doc.getMap("meta");
  for (let i = 0; i < 10; i++) {
    map.set(`key${i}`, `value${i}`);
  }
  doc.getArray("items").insert(
    0,
    Array.from({ length: 10 }, (_, i) => `item${i}`),
  );
  return doc;
}

function makeLargeDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const text = doc.getText("t");
  for (let i = 0; i < 1000; i++) {
    text.insert(i, String.fromCharCode(65 + (i % 26)));
  }
  return doc;
}

describe("Content Cipher Benchmarks", () => {
  describe("stripContent (V1 → V2 structure + sidecar)", () => {
    const smallUpdate = v1(makeSmallDoc());
    const mediumUpdate = v1(makeMediumDoc());
    const largeUpdate = v1(makeLargeDoc());

    it(`small doc (${formatBytes(smallUpdate.length)})`, async () => {
      await bench("stripContent small", () => stripContent(smallUpdate, 1), {
        iterations: 5000,
      });
    });

    it(`medium doc (${formatBytes(mediumUpdate.length)})`, async () => {
      await bench("stripContent medium", () => stripContent(mediumUpdate, 1), {
        iterations: 2000,
      });
    });

    it(`large doc (${formatBytes(largeUpdate.length)})`, async () => {
      await bench("stripContent large", () => stripContent(largeUpdate, 1), {
        iterations: 1000,
      });
    });
  });

  describe("restoreContent (V2 structure + sidecar → V1)", () => {
    const smallStripped = stripContent(v1(makeSmallDoc()), 1);
    const mediumStripped = stripContent(v1(makeMediumDoc()), 1);
    const largeStripped = stripContent(v1(makeLargeDoc()), 1);

    it("small doc", async () => {
      await bench(
        "restoreContent small",
        () => restoreContent(smallStripped.update, smallStripped.sidecar, 1),
        { iterations: 5000 },
      );
    });

    it("medium doc", async () => {
      await bench(
        "restoreContent medium",
        () => restoreContent(mediumStripped.update, mediumStripped.sidecar, 1),
        { iterations: 2000 },
      );
    });

    it("large doc", async () => {
      await bench(
        "restoreContent large",
        () => restoreContent(largeStripped.update, largeStripped.sidecar, 1),
        { iterations: 1000 },
      );
    });
  });

  describe("gcSidecar", () => {
    it("medium doc, ~50% deleted", async () => {
      const doc = makeMediumDoc();
      const { sidecar: oldSidecar } = stripContent(v1(doc), 1);
      doc.getText("body").delete(0, 50);
      doc.getMap("meta").delete("key0");
      doc.getMap("meta").delete("key1");
      doc.getArray("items").delete(0, 5);
      const { update: structUpdate, sidecar: freshSidecar } = stripContent(v1(doc), 1);
      const merged = mergeSidecars([oldSidecar, freshSidecar]);

      await bench("gcSidecar medium ~50% deleted", () => gcSidecar(structUpdate, merged), {
        iterations: 2000,
      });
    });

    it("no-op GC (nothing deleted)", async () => {
      const { update, sidecar } = stripContent(v1(makeMediumDoc()), 1);
      await bench("gcSidecar no-op", () => gcSidecar(update, sidecar), {
        iterations: 2000,
      });
    });

    it("large doc, all deleted", async () => {
      const doc = makeLargeDoc();
      const { sidecar: oldSidecar } = stripContent(v1(doc), 1);
      doc.getText("t").delete(0, 1000);
      const { update: structUpdate } = stripContent(v1(doc), 1);

      await bench("gcSidecar large all-deleted", () => gcSidecar(structUpdate, oldSidecar), {
        iterations: 1000,
      });
    });
  });

  describe("sidecar encode/decode", () => {
    const smallSidecar = stripContent(v1(makeSmallDoc()), 1).sidecar;
    const mediumSidecar = stripContent(v1(makeMediumDoc()), 1).sidecar;
    const largeSidecar = stripContent(v1(makeLargeDoc()), 1).sidecar;
    const smallEncoded = encodeSidecar(smallSidecar);
    const mediumEncoded = encodeSidecar(mediumSidecar);
    const largeEncoded = encodeSidecar(largeSidecar);

    it(`encode small (${smallSidecar.entries.length} entries → ${formatBytes(smallEncoded.length)})`, async () => {
      await bench("encodeSidecar small", () => encodeSidecar(smallSidecar), {
        iterations: 5000,
      });
    });

    it(`encode medium (${mediumSidecar.entries.length} entries → ${formatBytes(mediumEncoded.length)})`, async () => {
      await bench("encodeSidecar medium", () => encodeSidecar(mediumSidecar), {
        iterations: 2000,
      });
    });

    it(`encode large (${largeSidecar.entries.length} entries → ${formatBytes(largeEncoded.length)})`, async () => {
      await bench("encodeSidecar large", () => encodeSidecar(largeSidecar), {
        iterations: 1000,
      });
    });

    it("decode small", async () => {
      await bench("decodeSidecar small", () => decodeSidecar(smallEncoded), {
        iterations: 5000,
      });
    });

    it("decode medium", async () => {
      await bench("decodeSidecar medium", () => decodeSidecar(mediumEncoded), {
        iterations: 2000,
      });
    });

    it("decode large", async () => {
      await bench("decodeSidecar large", () => decodeSidecar(largeEncoded), {
        iterations: 1000,
      });
    });
  });

  describe("overhead: strip+restore vs raw Y.js encode", () => {
    it("Y.encodeStateAsUpdate baseline (medium)", async () => {
      const doc = makeMediumDoc();
      await bench("Y.encodeStateAsUpdate medium", () => Y.encodeStateAsUpdate(doc), {
        iterations: 2000,
      });
    });

    it("strip + restore round-trip (medium)", async () => {
      const update = v1(makeMediumDoc());
      await bench(
        "strip+restore medium",
        () => {
          const { update: s, sidecar } = stripContent(update, 1);
          restoreContent(s, sidecar, 1);
        },
        { iterations: 2000 },
      );
    });

    it("full pipeline: strip + GC + restore (medium, ~50% deleted)", async () => {
      const doc = makeMediumDoc();
      const { sidecar: oldSidecar } = stripContent(v1(doc), 1);
      doc.getText("body").delete(0, 50);
      doc.getMap("meta").delete("key0");
      doc.getArray("items").delete(0, 5);
      const update = v1(doc);

      await bench(
        "strip+gc+restore medium",
        () => {
          const { update: s, sidecar } = stripContent(update, 1);
          const merged = mergeSidecars([oldSidecar, sidecar]);
          const gced = gcSidecar(s, merged);
          restoreContent(s, gced, 1);
        },
        { iterations: 1000 },
      );
    });
  });

  describe("V1-raw fast path (no tokenization, no V2 conversion)", () => {
    const smallUpdate = v1(makeSmallDoc());
    const mediumUpdate = v1(makeMediumDoc());
    const largeUpdate = v1(makeLargeDoc());

    it(`stripContent V1-raw small (${formatBytes(smallUpdate.length)})`, async () => {
      await bench("stripContent V1-raw small", () => stripContent(smallUpdate, 1, false), {
        iterations: 5000,
      });
    });

    it(`stripContent V1-raw medium (${formatBytes(mediumUpdate.length)})`, async () => {
      await bench("stripContent V1-raw medium", () => stripContent(mediumUpdate, 1, false), {
        iterations: 2000,
      });
    });

    it(`stripContent V1-raw large (${formatBytes(largeUpdate.length)})`, async () => {
      await bench("stripContent V1-raw large", () => stripContent(largeUpdate, 1, false), {
        iterations: 1000,
      });
    });

    it("restoreContent V1-raw small", async () => {
      const stripped = stripContent(smallUpdate, 1, false);
      await bench(
        "restoreContent V1-raw small",
        () => restoreContent(stripped.update, stripped.sidecar, 1, 1),
        { iterations: 5000 },
      );
    });

    it("restoreContent V1-raw medium", async () => {
      const stripped = stripContent(mediumUpdate, 1, false);
      await bench(
        "restoreContent V1-raw medium",
        () => restoreContent(stripped.update, stripped.sidecar, 1, 1),
        { iterations: 2000 },
      );
    });

    it("restoreContent V1-raw large", async () => {
      const stripped = stripContent(largeUpdate, 1, false);
      await bench(
        "restoreContent V1-raw large",
        () => restoreContent(stripped.update, stripped.sidecar, 1, 1),
        { iterations: 1000 },
      );
    });

    it("strip+restore V1-raw round-trip (medium)", async () => {
      await bench(
        "strip+restore V1-raw medium",
        () => {
          const { update: s, sidecar } = stripContent(mediumUpdate, 1, false);
          restoreContent(s, sidecar, 1, 1);
        },
        { iterations: 2000 },
      );
    });

    it("gcSidecar V1-raw medium no-op", async () => {
      const { update, sidecar } = stripContent(mediumUpdate, 1, false);
      await bench("gcSidecar V1-raw no-op", () => gcSidecar(update, sidecar, 1), {
        iterations: 2000,
      });
    });

    it("full pipeline V1-raw: strip + GC + restore (medium, ~50% deleted)", async () => {
      const doc = makeMediumDoc();
      const { sidecar: oldSidecar } = stripContent(v1(doc), 1, false);
      doc.getText("body").delete(0, 50);
      doc.getMap("meta").delete("key0");
      doc.getArray("items").delete(0, 5);
      const update = v1(doc);

      await bench(
        "strip+gc+restore V1-raw medium",
        () => {
          const { update: s, sidecar } = stripContent(update, 1, false);
          const merged = mergeSidecars([oldSidecar, sidecar]);
          const gced = gcSidecar(s, merged, 1);
          restoreContent(s, gced, 1, 1);
        },
        { iterations: 1000 },
      );
    });
  });
});
