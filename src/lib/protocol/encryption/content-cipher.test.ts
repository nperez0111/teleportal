import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createEncryptionKey } from "teleportal/encryption-key";
import {
  stripContent,
  restoreContent,
  encodeSidecar,
  decodeSidecar,
  encryptUpdateContent,
  decryptUpdateContent,
  buildSidecarIndex,
  buildSidecarIndexFromUpdateMeta,
  sidecarOverlapsDiff,
  type ContentEntry,
  type Sidecar,
} from "./content-cipher";

function makeDoc(fn: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc();
  fn(doc);
  return doc;
}

function getV1Update(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function applyAndReadV1(update: Uint8Array, reader: (doc: Y.Doc) => unknown): unknown {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return reader(doc);
}

type ServerItem = {
  type: string;
  length?: number;
  str?: string;
  values?: unknown[];
  key?: string;
  value?: unknown;
  childType?: string;
  children?: ServerTypeView;
};

type ServerTypeView = {
  mapKeys?: Record<string, ServerItem>;
  items?: ServerItem[];
};

function inspectServerType(type: Y.AbstractType<any>): ServerTypeView {
  const result: ServerTypeView = {};

  // Map entries (parentSub keyed items)
  const map = (type as any)._map as Map<string, any> | undefined;
  if (map && map.size > 0) {
    result.mapKeys = {};
    for (const [k, item] of map) {
      if (item.content) {
        result.mapKeys[k] = describeContent(item.content);
      }
    }
  }

  // List items
  let item = (type as any)._start;
  if (item) {
    result.items = [];
    while (item) {
      if (item.content) {
        const desc = describeContent(item.content);
        if (desc.childType && item.content.type) {
          desc.children = inspectServerType(item.content.type);
        }
        result.items.push(desc);
      }
      item = item.right;
    }
  }

  return result;
}

function describeContent(content: any): ServerItem {
  const typeName = content.constructor.name as string;
  const item: ServerItem = { type: typeName.replace("Content", "") };

  if (content.str !== undefined) item.str = content.str;
  if (content.arr !== undefined) item.values = content.arr;
  if (content.len !== undefined && typeName === "ContentDeleted") item.length = content.len;
  if (content.key !== undefined) item.key = content.key;
  if (content.value !== undefined) item.value = content.value;
  if (content.type) item.childType = content.type.constructor.name;
  if (content.embed) item.value = content.embed;

  return item;
}

function serverView(doc: Y.Doc): Record<string, ServerTypeView> {
  const { update: stripped } = stripContent(getV1Update(doc), 1);
  const serverDoc = new Y.Doc();
  Y.applyUpdateV2(serverDoc, stripped);

  const view: Record<string, ServerTypeView> = {};
  for (const [key, type] of serverDoc.share) {
    view[key] = inspectServerType(type);
  }
  return view;
}

describe("content-cipher", () => {
  describe("stripContent / restoreContent round-trip", () => {
    it("round-trips a simple text insert", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "Hello World"));
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      expect(sidecar.entries.length).toBe(1);
      expect(sidecar.entries[0].contentRef).toBe(4); // ContentString

      // Structure update doesn't contain original content
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("Hello World");

      // Restoring produces the original update
      const restored = restoreContent(stripped, sidecar, 1);
      const restoredText = applyAndReadV1(restored, (d) => d.getText("t").toString());
      expect(restoredText).toBe("Hello World");
    });

    it("round-trips ContentAny (map values)", () => {
      const doc = makeDoc((d) => {
        const map = d.getMap("m");
        map.set("name", "Alice");
        map.set("age", 30);
        map.set("active", true);
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      expect(sidecar.entries.length).toBeGreaterThan(0);

      const restored = restoreContent(stripped, sidecar, 1);
      const result = applyAndReadV1(restored, (d) => {
        const map = d.getMap("m");
        return { name: map.get("name"), age: map.get("age"), active: map.get("active") };
      });
      expect(result).toEqual({ name: "Alice", age: 30, active: true });
    });

    it("round-trips ContentFormat (text formatting)", () => {
      const doc = makeDoc((d) => {
        const text = d.getText("t");
        text.insert(0, "Hello World");
        text.format(0, 5, { bold: true });
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const formatEntries = sidecar.entries.filter((e) => e.contentRef === 6);
      expect(formatEntries.length).toBeGreaterThan(0);

      const restored = restoreContent(stripped, sidecar, 1);
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, restored);
      const delta = doc2.getText("t").toDelta();
      expect(delta).toEqual([
        { insert: "Hello", attributes: { bold: true } },
        { insert: " World" },
      ]);
    });

    it("round-trips ContentEmbed", () => {
      const doc = makeDoc((d) => {
        d.getText("t").insertEmbed(0, { image: "https://example.com/img.png" });
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const embedEntries = sidecar.entries.filter((e) => e.contentRef === 5);
      expect(embedEntries.length).toBe(1);

      const restored = restoreContent(stripped, sidecar, 1);
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, restored);
      const delta = doc2.getText("t").toDelta();
      expect(delta[0].insert).toEqual({ image: "https://example.com/img.png" });
    });

    it("round-trips ContentType (nested shared types)", () => {
      const doc = makeDoc((d) => {
        const arr = d.getArray("a");
        const nestedMap = new Y.Map();
        arr.insert(0, [nestedMap]);
        nestedMap.set("key", "value");
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const restored = restoreContent(stripped, sidecar, 1);
      const result = applyAndReadV1(restored, (d) => {
        const arr = d.getArray("a");
        return (arr.get(0) as Y.Map<string>).get("key");
      });
      expect(result).toBe("value");
    });

    it("round-trips ContentDeleted (tombstones)", () => {
      const doc = makeDoc((d) => {
        const text = d.getText("t");
        text.insert(0, "Hello World");
        text.delete(5, 6);
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const restored = restoreContent(stripped, sidecar, 1);
      const restoredText = applyAndReadV1(restored, (d) => d.getText("t").toString());
      expect(restoredText).toBe("Hello");
    });

    it("round-trips array values (ContentAny with multiple items)", () => {
      const doc = makeDoc((d) => {
        d.getArray("a").insert(0, ["item1", "item2", 42, true, null]);
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const restored = restoreContent(stripped, sidecar, 1);
      const result = applyAndReadV1(restored, (d) => d.getArray("a").toArray());
      expect(result).toEqual(["item1", "item2", 42, true, null]);
    });

    it("round-trips a complex document with multiple types", () => {
      const doc = makeDoc((d) => {
        d.getText("title").insert(0, "My Document");
        d.getText("body").insert(0, "Some content here");
        d.getText("body").format(5, 7, { italic: true });
        d.getMap("meta").set("author", "Alice");
        d.getMap("meta").set("version", 2);
        d.getArray("tags").insert(0, ["draft", "important"]);
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      expect(sidecar.entries.length).toBeGreaterThan(0);

      const restored = restoreContent(stripped, sidecar, 1);
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, restored);

      expect(doc2.getText("title").toString()).toBe("My Document");
      expect(doc2.getText("body").toString()).toBe("Some content here");
      expect(doc2.getMap("meta").get("author")).toBe("Alice");
      expect(doc2.getMap("meta").get("version")).toBe(2);
      expect(doc2.getArray("tags").toArray()).toEqual(["draft", "important"]);
    });
  });

  describe("structure update validity", () => {
    it("produces a valid V2 Y.js update that can be applied", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "Secret text"));
      const { update: stripped } = stripContent(getV1Update(doc), 1);

      const doc2 = new Y.Doc();
      expect(() => Y.applyUpdateV2(doc2, stripped)).not.toThrow();
    });

    it("structure updates can be merged by Y.js (V2)", () => {
      const doc1 = makeDoc((d) => d.getText("t").insert(0, "Hello"));
      const doc2 = makeDoc((d) => d.getText("t").insert(0, "World"));

      const { update: s1 } = stripContent(getV1Update(doc1), 1);
      const { update: s2 } = stripContent(getV1Update(doc2), 1);

      expect(() => Y.mergeUpdatesV2([s1, s2])).not.toThrow();
    });

    it("state vectors work correctly with structure updates", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "Hello"));
      const { update: stripped } = stripContent(getV1Update(doc), 1);

      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, stripped);

      const sv = Y.encodeStateVector(doc2);
      expect(sv.length).toBeGreaterThan(0);

      const originalDoc = new Y.Doc();
      Y.applyUpdate(originalDoc, getV1Update(doc));
      const originalSv = Y.encodeStateVector(originalDoc);
      expect(sv).toEqual(originalSv);
    });
  });

  describe("sidecar encoding", () => {
    it("round-trips sidecar entries", () => {
      const entries: ContentEntry[] = [
        { clientId: 123, clock: 0, contentRef: 4, data: new Uint8Array([1, 2, 3]), itemLength: 3 },
        {
          clientId: 456,
          clock: 5,
          contentRef: 8,
          data: new Uint8Array([4, 5, 6, 7]),
          itemLength: 2,
        },
      ];
      const sidecar: Sidecar = { entries, dictionary: new Map() };
      const encoded = encodeSidecar(sidecar);
      const decoded = decodeSidecar(encoded);
      expect(decoded.entries).toEqual(entries);
      expect(decoded.dictionary.size).toBe(0);
    });

    it("round-trips sidecar entries with dictionary", () => {
      const entries: ContentEntry[] = [
        { clientId: 123, clock: 0, contentRef: 4, data: new Uint8Array([1, 2, 3]), itemLength: 3 },
      ];
      const dictionary: Map<string, string> = new Map([
        ["abc123", "password"],
        ["def456", "secret-key"],
      ]);
      const sidecar: Sidecar = { entries, dictionary };
      const encoded = encodeSidecar(sidecar);
      const decoded = decodeSidecar(encoded);
      expect(decoded.entries).toEqual(entries);
      expect(decoded.dictionary).toEqual(dictionary);
    });

    it("handles empty entries", () => {
      const encoded = encodeSidecar({ entries: [], dictionary: new Map() });
      const decoded = decodeSidecar(encoded);
      expect(decoded.entries).toEqual([]);
    });

    it("rejects invalid version", () => {
      const bad = new Uint8Array([99, 0]); // version 99
      expect(() => decodeSidecar(bad)).toThrow("Unsupported sidecar version");
    });

    it("groups entries by client for compression", () => {
      const sameClient = Array.from({ length: 20 }, (_, i) => ({
        clientId: 42,
        clock: i * 2,
        contentRef: 4,
        data: new Uint8Array([0x41 + i]),
        itemLength: 1,
      }));
      const encoded = encodeSidecar({ entries: sameClient, dictionary: new Map() });
      const decoded = decodeSidecar(encoded);
      expect(decoded.entries).toEqual(sameClient);

      // Verify compression: 20 entries with same client and ref should be much
      // smaller than 20 × (clientId + clock + ref) in naive encoding
      // Naive overhead per entry: ~5B (clientId) + ~1B (clock) + 1B (ref) + 2B (data) = ~9B
      // Compact should use delta-encoded clocks and RLE refs
      expect(encoded.length).toBeLessThan(20 * 9 + 10);
    });

    it("handles multiple client groups", () => {
      const entries: ContentEntry[] = [
        { clientId: 100, clock: 0, contentRef: 4, data: new Uint8Array([1]), itemLength: 1 },
        { clientId: 100, clock: 5, contentRef: 4, data: new Uint8Array([2]), itemLength: 1 },
        { clientId: 200, clock: 0, contentRef: 8, data: new Uint8Array([3, 4]), itemLength: 1 },
        { clientId: 200, clock: 1, contentRef: 8, data: new Uint8Array([5, 6]), itemLength: 1 },
        { clientId: 200, clock: 2, contentRef: 6, data: new Uint8Array([7]), itemLength: 1 },
      ];
      const decoded = decodeSidecar(encodeSidecar({ entries, dictionary: new Map() }));
      expect(decoded.entries).toEqual(entries);
    });
  });

  describe("encrypted API (with CryptoKey)", () => {
    it("encrypts and decrypts a V1 update", async () => {
      const key = await createEncryptionKey();
      const doc = makeDoc((d) => d.getText("t").insert(0, "Secret message"));
      const original = getV1Update(doc);

      const encrypted = await encryptUpdateContent(key, original, 1);

      // Structure update doesn't contain the secret
      const strippedStr = Buffer.from(encrypted.structureUpdate).toString("utf-8");
      expect(strippedStr).not.toContain("Secret message");

      // Decryption restores the original content
      const decrypted = await decryptUpdateContent(key, encrypted, 1);
      const restoredText = applyAndReadV1(decrypted, (d) => d.getText("t").toString());
      expect(restoredText).toBe("Secret message");
    });

    it("encrypts V2 input and decrypts to V2 output", async () => {
      const key = await createEncryptionKey();
      const doc = makeDoc((d) => d.getText("t").insert(0, "V2 test"));
      const originalV2 = Y.encodeStateAsUpdateV2(doc);

      const encrypted = await encryptUpdateContent(key, originalV2, 2);
      const decryptedV2 = await decryptUpdateContent(key, encrypted, 2);

      const doc2 = new Y.Doc();
      Y.applyUpdateV2(doc2, decryptedV2);
      expect(doc2.getText("t").toString()).toBe("V2 test");
    });

    it("fails decryption with wrong key", async () => {
      const key1 = await createEncryptionKey();
      const key2 = await createEncryptionKey();
      const doc = makeDoc((d) => d.getText("t").insert(0, "Secret"));
      const original = getV1Update(doc);

      const encrypted = await encryptUpdateContent(key1, original, 1);
      await expect(decryptUpdateContent(key2, encrypted, 1)).rejects.toThrow();
    });
  });

  describe("content is not leaked in structure update", () => {
    it("text content is replaced with null bytes", () => {
      const secretText = "This is a very secret message that must not leak";
      const doc = makeDoc((d) => d.getText("t").insert(0, secretText));
      const { update: stripped } = stripContent(getV1Update(doc), 1);

      const strippedHex = Buffer.from(stripped).toString("hex");
      const secretHex = Buffer.from(secretText).toString("hex");
      expect(strippedHex).not.toContain(secretHex);

      // Also check the raw bytes don't contain any recognizable substring
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("secret");
      expect(strippedStr).not.toContain("message");
      expect(strippedStr).not.toContain("leak");
    });

    it("map values are not present in structure update", () => {
      const doc = makeDoc((d) => {
        d.getMap("m").set("password", "hunter2");
        d.getMap("m").set("ssn", "123-45-6789");
      });
      const { update: stripped } = stripContent(getV1Update(doc), 1);
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("hunter2");
      expect(strippedStr).not.toContain("123-45-6789");
    });

    it("embed content is not present in structure update", () => {
      const doc = makeDoc((d) => {
        d.getText("t").insertEmbed(0, { secret: "classified-url" });
      });
      const { update: stripped } = stripContent(getV1Update(doc), 1);
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("classified-url");
    });
  });

  describe("metadata strings are not leaked in structure update", () => {
    it("map keys (parentSub) are replaced with opaque tokens", () => {
      const doc = makeDoc((d) => {
        d.getMap("m").set("password", "hunter2");
        d.getMap("m").set("ssn", "123-45-6789");
      });
      const { update: stripped, sidecar } = stripContent(getV1Update(doc), 1);
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("password");
      expect(strippedStr).not.toContain("ssn");
      expect([...sidecar.dictionary.values()]).toContain("password");
      expect([...sidecar.dictionary.values()]).toContain("ssn");
    });

    it("root type keys are replaced with opaque tokens", () => {
      const doc = makeDoc((d) => {
        d.getText("patient-records").insert(0, "sensitive");
        d.getMap("medical-history").set("key", "value");
      });
      const { update: stripped, sidecar } = stripContent(getV1Update(doc), 1);
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("patient-records");
      expect(strippedStr).not.toContain("medical-history");
      expect([...sidecar.dictionary.values()]).toContain("patient-records");
      expect([...sidecar.dictionary.values()]).toContain("medical-history");
    });

    it("XML element tag names are replaced with opaque tokens", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("xml");
      const el = new Y.XmlElement("secret-component");
      frag.insert(0, [el]);
      const { update: stripped, sidecar } = stripContent(getV1Update(doc), 1);
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("secret-component");
      expect([...sidecar.dictionary.values()]).toContain("secret-component");
    });

    it("XML attribute names are replaced with opaque tokens", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("xml");
      const el = new Y.XmlElement("div");
      frag.insert(0, [el]);
      el.setAttribute("data-secret-attr", "value123");
      const { update: stripped, sidecar } = stripContent(getV1Update(doc), 1);
      const strippedStr = Buffer.from(stripped).toString("utf-8");
      expect(strippedStr).not.toContain("data-secret-attr");
      expect(strippedStr).not.toContain("value123");
      expect([...sidecar.dictionary.values()]).toContain("data-secret-attr");
    });

    it("tokens are deterministic across separate stripContent calls", () => {
      const doc1 = makeDoc((d) => d.getMap("m").set("password", "abc"));
      const doc2 = makeDoc((d) => d.getMap("m").set("password", "xyz"));
      const { sidecar: s1 } = stripContent(getV1Update(doc1), 1);
      const { sidecar: s2 } = stripContent(getV1Update(doc2), 1);
      const token1 = [...s1.dictionary.entries()].find(([, v]) => v === "password")?.[0];
      const token2 = [...s2.dictionary.entries()].find(([, v]) => v === "password")?.[0];
      expect(token1).toBeDefined();
      expect(token1).toBe(token2);
    });

    it("server sees only opaque structure: text with formatting", () => {
      const doc = new Y.Doc();
      doc.getText("patient-notes").insert(0, "Diagnosis: severe");
      doc.getText("patient-notes").format(0, 9, { bold: true });
      expect(serverView(doc)).toMatchSnapshot();
    });

    it("server sees only opaque structure: map with keys", () => {
      const doc = new Y.Doc();
      const meta = doc.getMap("patient-record");
      meta.set("ssn", "123-45-6789");
      meta.set("name", "John Doe");
      meta.set("age", 42);
      meta.set("medications", ["aspirin", "metformin"]);
      expect(serverView(doc)).toMatchSnapshot();
    });

    it("server sees only opaque structure: nested map", () => {
      const doc = new Y.Doc();
      const meta = doc.getMap("settings");
      const nested = new Y.Map();
      meta.set("theme", nested);
      nested.set("primary-color", "#ff0000");
      nested.set("font-size", 14);
      expect(serverView(doc)).toMatchSnapshot();
    });

    it("server sees only opaque structure: array", () => {
      const doc = new Y.Doc();
      doc.getArray("diagnosis-codes").insert(0, ["ICD-10-A01", "ICD-10-B02", true, 42, null]);
      expect(serverView(doc)).toMatchSnapshot();
    });

    it("server sees only opaque structure: array with nested shared type", () => {
      const doc = new Y.Doc();
      const sections = doc.getArray("sections");
      sections.insert(0, [new Y.Text("Section content")]);
      expect(serverView(doc)).toMatchSnapshot();
    });

    it("server sees only opaque structure: xml with elements and attributes", () => {
      const doc = new Y.Doc();
      const xml = doc.getXmlFragment("clinical-form");
      const div = new Y.XmlElement("patient-info-panel");
      xml.insert(0, [div]);
      div.setAttribute("data-patient-id", "P-12345");
      div.setAttribute("class", "confidential");
      const span = new Y.XmlElement("diagnosis-field");
      div.insert(0, [span]);
      span.insert(0, [new Y.XmlText("Cancer stage IV")]);
      expect(serverView(doc)).toMatchSnapshot();
    });

    it("server sees only opaque structure: embed", () => {
      const doc = new Y.Doc();
      doc.getText("notes").insert(0, "See image:");
      doc.getText("notes").insertEmbed(10, { image: "https://scans.hospital.com/mri-123.png" });
      expect(serverView(doc)).toMatchSnapshot();
    });

    it("server sees only opaque structure: comprehensive document", () => {
      const doc = new Y.Doc();

      // Text with formatting and embeds
      const text = doc.getText("patient-notes");
      text.insert(0, "Diagnosis: severe condition");
      text.format(0, 9, { bold: true });
      text.insertEmbed(27, { image: "https://scans.hospital.com/mri-123.png" });

      // Map with sensitive keys
      const meta = doc.getMap("patient-record");
      meta.set("ssn", "123-45-6789");
      meta.set("name", "John Doe");
      meta.set("age", 42);
      meta.set("medications", ["aspirin", "metformin"]);

      // Nested map
      const nested = new Y.Map();
      meta.set("address", nested);
      nested.set("street", "123 Main St");
      nested.set("city", "Springfield");

      // Array
      doc.getArray("diagnosis-codes").insert(0, ["ICD-10-A01", "ICD-10-B02", true, 42, null]);

      // Nested shared type in array
      const sections = doc.getArray("sections");
      sections.insert(0, [new Y.Text("Section content")]);

      // XML with sensitive tag/attr names
      const xml = doc.getXmlFragment("clinical-form");
      const div = new Y.XmlElement("patient-info-panel");
      xml.insert(0, [div]);
      div.setAttribute("data-patient-id", "P-12345");
      div.setAttribute("class", "confidential");
      const span = new Y.XmlElement("diagnosis-field");
      div.insert(0, [span]);
      span.insert(0, [new Y.XmlText("Cancer stage IV")]);

      expect(serverView(doc)).toMatchSnapshot();
    });
  });

  describe("CRDT metadata preservation", () => {
    it("preserves client IDs and clocks across strip/restore", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "Test"));
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const restored = restoreContent(stripped, sidecar, 1);

      // Both should produce the same state vectors
      const doc1 = new Y.Doc();
      Y.applyUpdate(doc1, original);
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, restored);

      expect(Y.encodeStateVector(doc1)).toEqual(Y.encodeStateVector(doc2));
    });

    it("preserves delete sets", () => {
      const doc = makeDoc((d) => {
        const text = d.getText("t");
        text.insert(0, "Hello World");
        text.delete(0, 5);
      });
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const restored = restoreContent(stripped, sidecar, 1);

      const doc1 = new Y.Doc();
      Y.applyUpdate(doc1, original);
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, restored);

      expect(doc1.getText("t").toString()).toBe(doc2.getText("t").toString());
      expect(Y.encodeStateVector(doc1)).toEqual(Y.encodeStateVector(doc2));
    });

    it("structure updates from different clients can sync", () => {
      const doc1 = makeDoc((d) => d.getText("t").insert(0, "Hello"));
      const doc2 = makeDoc((d) => d.getText("t").insert(0, "World"));

      const { update: s1 } = stripContent(getV1Update(doc1), 1);
      const { update: s2 } = stripContent(getV1Update(doc2), 1);

      const merged = Y.mergeUpdatesV2([s1, s2]);

      const serverDoc = new Y.Doc();
      expect(() => Y.applyUpdateV2(serverDoc, merged)).not.toThrow();
    });
  });

  describe("incremental updates", () => {
    it("handles incremental updates (not full state)", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello");

      const fullUpdate = Y.encodeStateAsUpdate(doc);
      const sv = Y.encodeStateVector(doc);

      doc.getText("t").insert(5, " World");
      const incrementalUpdate = Y.encodeStateAsUpdate(doc, sv);

      const { update: stripped, sidecar } = stripContent(incrementalUpdate, 1);
      expect(sidecar.entries.length).toBe(1);
      expect(sidecar.entries[0].contentRef).toBe(4);

      const restored = restoreContent(stripped, sidecar, 1);

      // Apply full state first (same doc, same client IDs), then incremental
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, fullUpdate);
      Y.applyUpdate(doc2, restored);
      expect(doc2.getText("t").toString()).toBe("Hello World");
    });
  });

  describe("unicode content", () => {
    it("handles multi-byte UTF-8 characters", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "Hello 🌍 World 日本語"));
      const original = getV1Update(doc);

      const { update: stripped, sidecar } = stripContent(original, 1);
      const restored = restoreContent(stripped, sidecar, 1);
      const restoredText = applyAndReadV1(restored, (d) => d.getText("t").toString());
      expect(restoredText).toBe("Hello 🌍 World 日本語");
    });
  });

  describe("byte-for-byte round-trip fidelity", () => {
    function expectByteExact(label: string, original: Uint8Array) {
      const { update: stripped, sidecar } = stripContent(original, 1);
      const restored = restoreContent(stripped, sidecar, 1);
      expect(Buffer.from(restored).equals(Buffer.from(original))).toBe(true);
    }

    // ── YText operations ─────────────────────────────────────────────────

    it("byte-exact: simple text insert", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "Hello World"));
      expectByteExact("simple text", getV1Update(doc));
    });

    it("byte-exact: text insert at multiple positions", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "AC");
      doc.getText("t").insert(1, "B");
      expectByteExact("multi-position insert", getV1Update(doc));
    });

    it("byte-exact: text delete in the middle", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").delete(5, 1);
      expectByteExact("text delete middle", getV1Update(doc));
    });

    it("byte-exact: text delete at start", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").delete(0, 5);
      expectByteExact("text delete start", getV1Update(doc));
    });

    it("byte-exact: text delete at end", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").delete(5, 6);
      expectByteExact("text delete end", getV1Update(doc));
    });

    it("byte-exact: text replace (delete + insert)", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").delete(0, 5);
      doc.getText("t").insert(0, "Goodbye");
      expectByteExact("text replace", getV1Update(doc));
    });

    it("byte-exact: bold formatting", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").format(0, 5, { bold: true });
      expectByteExact("bold format", getV1Update(doc));
    });

    it("byte-exact: multiple formatting attributes", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").format(0, 5, { bold: true, color: "#ff0000" });
      doc.getText("t").format(6, 5, { italic: true });
      expectByteExact("multi-format", getV1Update(doc));
    });

    it("byte-exact: formatting removed (null value)", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello");
      doc.getText("t").format(0, 5, { bold: true });
      doc.getText("t").format(0, 5, { bold: null });
      expectByteExact("format removed", getV1Update(doc));
    });

    it("byte-exact: embed in text", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "before");
      doc.getText("t").insertEmbed(6, { image: "https://example.com/cat.png", width: 200 });
      doc.getText("t").insert(7, "after");
      expectByteExact("embed", getV1Update(doc));
    });

    it("byte-exact: unicode text (emoji + CJK + RTL)", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "Hello 🌍🎉 World 日本語 مرحبا"));
      expectByteExact("unicode", getV1Update(doc));
    });

    it("byte-exact: surrogate pairs", () => {
      const doc = makeDoc((d) => d.getText("t").insert(0, "𝕳𝖊𝖑𝖑𝖔 𝖂𝖔𝖗𝖑𝖉"));
      expectByteExact("surrogate pairs", getV1Update(doc));
    });

    // ── YMap operations ──────────────────────────────────────────────────

    it("byte-exact: map with string values", () => {
      const doc = makeDoc((d) => {
        d.getMap("m").set("key1", "value1");
        d.getMap("m").set("key2", "value2");
      });
      expectByteExact("map strings", getV1Update(doc));
    });

    it("byte-exact: map with mixed value types", () => {
      const doc = makeDoc((d) => {
        const m = d.getMap("m");
        m.set("str", "hello");
        m.set("num", 42);
        m.set("float", 3.14);
        m.set("bool", true);
        m.set("null", null);
        m.set("arr", [1, 2, 3]);
        m.set("obj", { nested: true });
      });
      expectByteExact("map mixed types", getV1Update(doc));
    });

    it("byte-exact: map value replacement", () => {
      const doc = new Y.Doc();
      doc.getMap("m").set("key", "original");
      doc.getMap("m").set("key", "replaced");
      expectByteExact("map replace", getV1Update(doc));
    });

    it("byte-exact: map value deletion", () => {
      const doc = new Y.Doc();
      doc.getMap("m").set("keep", "yes");
      doc.getMap("m").set("remove", "bye");
      doc.getMap("m").delete("remove");
      expectByteExact("map delete", getV1Update(doc));
    });

    it("byte-exact: map with nested YMap", () => {
      const doc = new Y.Doc();
      const outer = doc.getMap("m");
      const inner = new Y.Map();
      outer.set("nested", inner);
      inner.set("deep", "value");
      expectByteExact("nested map", getV1Update(doc));
    });

    // ── YArray operations ────────────────────────────────────────────────

    it("byte-exact: array of primitives", () => {
      const doc = makeDoc((d) => {
        d.getArray("a").insert(0, [1, "two", true, null, 3.14]);
      });
      expectByteExact("array primitives", getV1Update(doc));
    });

    it("byte-exact: array splice (insert in middle)", () => {
      const doc = new Y.Doc();
      doc.getArray("a").insert(0, ["a", "c"]);
      doc.getArray("a").insert(1, ["b"]);
      expectByteExact("array splice", getV1Update(doc));
    });

    it("byte-exact: array delete", () => {
      const doc = new Y.Doc();
      doc.getArray("a").insert(0, ["a", "b", "c", "d"]);
      doc.getArray("a").delete(1, 2);
      expectByteExact("array delete", getV1Update(doc));
    });

    it("byte-exact: array with nested YText", () => {
      const doc = new Y.Doc();
      const text = new Y.Text("inner text");
      doc.getArray("a").insert(0, [text]);
      expectByteExact("array nested YText", getV1Update(doc));
    });

    it("byte-exact: array with nested YArray", () => {
      const doc = new Y.Doc();
      const inner = new Y.Array();
      doc.getArray("a").insert(0, [inner]);
      inner.insert(0, [1, 2, 3]);
      expectByteExact("array nested YArray", getV1Update(doc));
    });

    // ── YXmlFragment / YXmlElement ───────────────────────────────────────

    it("byte-exact: xml fragment with elements", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("xml");
      const el = new Y.XmlElement("div");
      frag.insert(0, [el]);
      el.setAttribute("class", "container");
      const span = new Y.XmlElement("span");
      el.insert(0, [span]);
      const txt = new Y.XmlText("hello world");
      span.insert(0, [txt]);
      expectByteExact("xml fragment", getV1Update(doc));
    });

    it("byte-exact: deeply nested xml structure", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("xml");

      const root = new Y.XmlElement("html");
      frag.insert(0, [root]);

      const body = new Y.XmlElement("body");
      root.insert(0, [body]);

      const div1 = new Y.XmlElement("div");
      div1.setAttribute("id", "main");
      div1.setAttribute("class", "content");
      body.insert(0, [div1]);

      const p = new Y.XmlElement("p");
      div1.insert(0, [p]);
      p.insert(0, [new Y.XmlText("Paragraph text")]);

      const ul = new Y.XmlElement("ul");
      div1.insert(1, [ul]);
      for (const item of ["Item 1", "Item 2", "Item 3"]) {
        const li = new Y.XmlElement("li");
        li.insert(0, [new Y.XmlText(item)]);
        ul.insert(ul.length, [li]);
      }

      expectByteExact("deep xml", getV1Update(doc));
    });

    it("byte-exact: xml element attribute changes", () => {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("xml");
      const el = new Y.XmlElement("div");
      frag.insert(0, [el]);
      el.setAttribute("style", "color: red");
      el.setAttribute("style", "color: blue");
      el.removeAttribute("style");
      el.setAttribute("data-id", "123");
      expectByteExact("xml attrs", getV1Update(doc));
    });

    // ── Multi-type documents ─────────────────────────────────────────────

    it("byte-exact: document with every content type", () => {
      const doc = new Y.Doc();

      // ContentString
      doc.getText("text").insert(0, "Hello World");
      // ContentFormat
      doc.getText("text").format(0, 5, { bold: true });
      // ContentEmbed
      doc.getText("text").insertEmbed(11, { type: "hr" });
      // ContentAny (map values)
      doc.getMap("meta").set("version", 1);
      doc.getMap("meta").set("title", "Test");
      // ContentAny (array values)
      doc.getArray("tags").insert(0, ["a", "b"]);
      // ContentType (nested shared types)
      const nestedMap = new Y.Map();
      doc.getArray("nested").insert(0, [nestedMap]);
      nestedMap.set("key", "val");
      // ContentDeleted
      doc.getText("text").delete(5, 1);

      expectByteExact("all content types", getV1Update(doc));
    });

    // ── Incremental updates ──────────────────────────────────────────────

    it("byte-exact: incremental update after text edit", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello");
      const sv = Y.encodeStateVector(doc);

      doc.getText("t").insert(5, " World");
      const inc = Y.encodeStateAsUpdate(doc, sv);
      expectByteExact("incremental text", inc);
    });

    it("byte-exact: incremental update after map change", () => {
      const doc = new Y.Doc();
      doc.getMap("m").set("a", 1);
      const sv = Y.encodeStateVector(doc);

      doc.getMap("m").set("b", 2);
      doc.getMap("m").set("a", 10);
      const inc = Y.encodeStateAsUpdate(doc, sv);
      expectByteExact("incremental map", inc);
    });

    it("byte-exact: incremental update with deletions", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "ABCDEF");
      const sv = Y.encodeStateVector(doc);

      doc.getText("t").delete(2, 2); // delete "CD"
      doc.getText("t").insert(2, "XY");
      const inc = Y.encodeStateAsUpdate(doc, sv);
      expectByteExact("incremental delete+insert", inc);
    });

    // ── Concurrent edits / multi-client ──────────────────────────────────

    it("byte-exact: merged update from two clients", () => {
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();

      doc1.getText("t").insert(0, "Hello");
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      doc1.getText("t").insert(5, " from A");
      doc2.getText("t").insert(5, " from B");

      // Cross-sync
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Both docs converge; take the merged full state
      const merged = Y.encodeStateAsUpdate(doc1);
      expectByteExact("merged two clients", merged);
    });

    it("byte-exact: three-way merge with formatting conflict", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const docC = new Y.Doc();

      docA.getText("t").insert(0, "Hello World");
      const base = Y.encodeStateAsUpdate(docA);
      Y.applyUpdate(docB, base);
      Y.applyUpdate(docC, base);

      docA.getText("t").format(0, 5, { bold: true });
      docB.getText("t").format(0, 5, { italic: true });
      docC.getText("t").insert(5, "!");

      // Merge all into docA
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docC));

      const merged = Y.encodeStateAsUpdate(docA);
      expectByteExact("three-way merge", merged);
    });

    // ── Edge cases ───────────────────────────────────────────────────────

    it("byte-exact: empty document", () => {
      const doc = new Y.Doc();
      expectByteExact("empty doc", getV1Update(doc));
    });

    it("byte-exact: document with only deletions (GC structs)", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "temp");
      doc.getText("t").delete(0, 4);
      expectByteExact("only deletions", getV1Update(doc));
    });

    it("byte-exact: very long text", () => {
      const longText = "A".repeat(10_000);
      const doc = makeDoc((d) => d.getText("t").insert(0, longText));
      expectByteExact("long text", getV1Update(doc));
    });

    it("byte-exact: many small items (character-by-character typing)", () => {
      const doc = new Y.Doc();
      const text = doc.getText("t");
      for (let i = 0; i < 100; i++) {
        text.insert(i, String.fromCharCode(65 + (i % 26)));
      }
      expectByteExact("char-by-char", getV1Update(doc));
    });

    it("byte-exact: multiple root-level shared types", () => {
      const doc = new Y.Doc();
      doc.getText("text1").insert(0, "First");
      doc.getText("text2").insert(0, "Second");
      doc.getMap("map1").set("a", 1);
      doc.getMap("map2").set("b", 2);
      doc.getArray("arr1").insert(0, [1]);
      doc.getArray("arr2").insert(0, [2]);
      expectByteExact("multiple roots", getV1Update(doc));
    });

    it("byte-exact: subdocument (ContentDoc)", () => {
      const doc = new Y.Doc();
      const subdoc = new Y.Doc({ guid: "subdoc-1" });
      doc.getMap("docs").set("child", subdoc);
      expectByteExact("subdoc", getV1Update(doc));
    });
  });

  describe("sidecar index", () => {
    describe("buildSidecarIndex", () => {
      it("computes clock ranges per client from entries", () => {
        const d = new Uint8Array([1]);
        const entries: ContentEntry[] = [
          { clientId: 1, clock: 0, contentRef: 4, data: d, itemLength: 1 },
          { clientId: 1, clock: 5, contentRef: 4, data: d, itemLength: 1 },
          { clientId: 1, clock: 10, contentRef: 4, data: d, itemLength: 1 },
          { clientId: 2, clock: 3, contentRef: 8, data: d, itemLength: 1 },
        ];
        const index = buildSidecarIndex(entries);
        expect(index).toEqual([
          { clientId: 1, minClock: 0, maxClock: 10 },
          { clientId: 2, minClock: 3, maxClock: 3 },
        ]);
      });

      it("extends maxClock to cover a multi-clock item's full range", () => {
        const d = new Uint8Array([1]);
        const entries: ContentEntry[] = [
          { clientId: 1, clock: 0, contentRef: 4, data: d, itemLength: 10 },
          { clientId: 1, clock: 20, contentRef: 4, data: d, itemLength: 1 },
        ];
        // clock 0 spans [0,10) → maxClock 9; the later single-clock item at 20
        // pushes it to 20.
        expect(buildSidecarIndex(entries)).toEqual([{ clientId: 1, minClock: 0, maxClock: 20 }]);
      });

      it("returns empty index for empty entries", () => {
        expect(buildSidecarIndex([])).toEqual([]);
      });

      it("handles single entry", () => {
        const entries: ContentEntry[] = [
          { clientId: 42, clock: 7, contentRef: 4, data: new Uint8Array([1]), itemLength: 1 },
        ];
        const index = buildSidecarIndex(entries);
        expect(index).toEqual([{ clientId: 42, minClock: 7, maxClock: 7 }]);
      });
    });

    describe("buildSidecarIndexFromUpdateMeta", () => {
      it("derives index from Y.parseUpdateMeta output", () => {
        const doc = new Y.Doc();
        doc.clientID = 1;
        doc.getText("t").insert(0, "Hello");
        const sv = Y.encodeStateVector(doc);

        doc.getText("t").insert(5, " World");
        const inc = Y.encodeStateAsUpdate(doc, sv);
        const meta = Y.parseUpdateMeta(inc);

        const index = buildSidecarIndexFromUpdateMeta(meta);
        expect(index.length).toBe(1);
        expect(index[0].clientId).toBe(1);
        expect(index[0].minClock).toBe(5);
        // "to" is exclusive, so maxClock = to - 1
        expect(index[0].maxClock).toBe(10);
      });
    });

    describe("sidecarOverlapsDiff", () => {
      it("returns true when sidecar range overlaps diff range", () => {
        const index = [{ clientId: 1, minClock: 0, maxClock: 10 }];
        const diffMeta = {
          from: new Map([[1, 5]]),
          to: new Map([[1, 15]]),
        };
        expect(sidecarOverlapsDiff(index, diffMeta)).toBe(true);
      });

      it("returns false when sidecar range is before diff range", () => {
        const index = [{ clientId: 1, minClock: 0, maxClock: 4 }];
        const diffMeta = {
          from: new Map([[1, 5]]),
          to: new Map([[1, 15]]),
        };
        expect(sidecarOverlapsDiff(index, diffMeta)).toBe(false);
      });

      it("returns false when sidecar range is after diff range", () => {
        const index = [{ clientId: 1, minClock: 20, maxClock: 30 }];
        const diffMeta = {
          from: new Map([[1, 5]]),
          to: new Map([[1, 15]]),
        };
        expect(sidecarOverlapsDiff(index, diffMeta)).toBe(false);
      });

      it("returns false when sidecar client is not in diff", () => {
        const index = [{ clientId: 99, minClock: 0, maxClock: 100 }];
        const diffMeta = {
          from: new Map([[1, 0]]),
          to: new Map([[1, 50]]),
        };
        expect(sidecarOverlapsDiff(index, diffMeta)).toBe(false);
      });

      it("handles boundary: sidecar maxClock == diffFrom (inclusive)", () => {
        const index = [{ clientId: 1, minClock: 3, maxClock: 5 }];
        const diffMeta = {
          from: new Map([[1, 5]]),
          to: new Map([[1, 10]]),
        };
        // maxClock(5) >= diffFrom(5) && minClock(3) < diffTo(10) → true
        expect(sidecarOverlapsDiff(index, diffMeta)).toBe(true);
      });

      it("handles boundary: sidecar minClock == diffTo (exclusive)", () => {
        const index = [{ clientId: 1, minClock: 10, maxClock: 15 }];
        const diffMeta = {
          from: new Map([[1, 5]]),
          to: new Map([[1, 10]]),
        };
        // minClock(10) < diffTo(10) is false → no overlap
        expect(sidecarOverlapsDiff(index, diffMeta)).toBe(false);
      });

      it("returns true if any client range overlaps", () => {
        const index = [
          { clientId: 1, minClock: 0, maxClock: 5 },
          { clientId: 2, minClock: 0, maxClock: 10 },
        ];
        const diffMeta = {
          from: new Map([[2, 5]]),
          to: new Map([[2, 15]]),
        };
        expect(sidecarOverlapsDiff(index, diffMeta)).toBe(true);
      });

      it("returns false for empty index", () => {
        const diffMeta = {
          from: new Map([[1, 0]]),
          to: new Map([[1, 10]]),
        };
        expect(sidecarOverlapsDiff([], diffMeta)).toBe(false);
      });
    });

    describe("integration: sidecar filtering with Y.js updates", () => {
      it("filters sidecars correctly for a partial sync", () => {
        // Client A writes "Hello"
        const docA = new Y.Doc();
        docA.clientID = 1;
        docA.getText("t").insert(0, "Hello");
        const updateA = Y.encodeStateAsUpdate(docA);
        const { sidecar: sidecarA } = stripContent(updateA, 1);
        const indexA = buildSidecarIndex(sidecarA.entries);

        // Client B writes "World"
        const docB = new Y.Doc();
        docB.clientID = 2;
        docB.getText("t").insert(0, "World");
        const updateB = Y.encodeStateAsUpdate(docB);
        const { sidecar: sidecarB } = stripContent(updateB, 1);
        const indexB = buildSidecarIndex(sidecarB.entries);

        // Server merges both structure updates
        const { update: strippedA } = stripContent(updateA, 1);
        const { update: strippedB } = stripContent(updateB, 1);
        const merged = Y.mergeUpdatesV2([strippedA, strippedB]);

        // A client that already has A's state requests sync
        const svA = Y.encodeStateVector(docA);
        const diff = Y.diffUpdateV2(merged, svA);
        const diffMeta = Y.parseUpdateMetaV2(diff);

        // Only B's sidecar should be relevant
        expect(sidecarOverlapsDiff(indexA, diffMeta)).toBe(false);
        expect(sidecarOverlapsDiff(indexB, diffMeta)).toBe(true);
      });

      it("includes all sidecars for empty client state vector", () => {
        const docA = new Y.Doc();
        docA.clientID = 1;
        docA.getText("t").insert(0, "Hello");
        const updateA = Y.encodeStateAsUpdate(docA);
        const { sidecar: sidecarA } = stripContent(updateA, 1);
        const indexA = buildSidecarIndex(sidecarA.entries);

        const docB = new Y.Doc();
        docB.clientID = 2;
        docB.getText("t").insert(0, "World");
        const updateB = Y.encodeStateAsUpdate(docB);
        const { sidecar: sidecarB } = stripContent(updateB, 1);
        const indexB = buildSidecarIndex(sidecarB.entries);

        const { update: strippedA } = stripContent(updateA, 1);
        const { update: strippedB } = stripContent(updateB, 1);
        const merged = Y.mergeUpdatesV2([strippedA, strippedB]);

        // Empty client → full diff
        const emptySV = Y.encodeStateVector(new Y.Doc());
        const diff = Y.diffUpdateV2(merged, emptySV);
        const diffMeta = Y.parseUpdateMetaV2(diff);

        expect(sidecarOverlapsDiff(indexA, diffMeta)).toBe(true);
        expect(sidecarOverlapsDiff(indexB, diffMeta)).toBe(true);
      });
    });
  });
});
