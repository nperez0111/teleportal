import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { generateEncryptionKey } from "teleportal/encryption-key";
import { createKeyedTokenizer, decryptUpdateContent, encryptUpdateContent } from "./content-cipher";

/**
 * Metadata key names (map keys, format keys) live in the plaintext structure
 * update as opaque tokens. The tokenizer must be deterministic per document
 * (so the server can merge edits to the same key) yet unguessable without the
 * key (so the server can't brute-force common field names).
 */
describe("keyed metadata tokenizer", () => {
  async function rawKeyBytes() {
    const key = await generateEncryptionKey();
    return { key, bytes: new Uint8Array(await crypto.subtle.exportKey("raw", key)) };
  }

  it("is deterministic for the same key + string", async () => {
    const { bytes } = await rawKeyBytes();
    const t = createKeyedTokenizer(bytes);
    expect(t("title")).toBe(t("title"));
    expect(t("title")).not.toBe(t("body"));
  });

  it("produces different tokens for different keys (unguessable without the key)", async () => {
    const a = await rawKeyBytes();
    const b = await rawKeyBytes();
    expect(createKeyedTokenizer(a.bytes)("title")).not.toBe(createKeyedTokenizer(b.bytes)("title"));
  });

  it("does not leak the field name and recovers it on decrypt", async () => {
    const { key, bytes } = await rawKeyBytes();
    const doc = new Y.Doc();
    doc.getMap("m").set("secretField", "value");

    const enc = await encryptUpdateContent(key, Y.encodeStateAsUpdateV2(doc), 2);
    const structureText = Buffer.from(enc.structureUpdate).toString("latin1");

    // The plaintext key name must not appear; the keyed token must.
    expect(structureText).not.toContain("secretField");
    expect(structureText).toContain(createKeyedTokenizer(bytes)("secretField"));

    // The decrypt path recovers the original key via the encrypted dictionary.
    const restored = await decryptUpdateContent(key, enc, 2);
    const out = new Y.Doc();
    Y.applyUpdateV2(out, restored);
    expect(out.getMap("m").get("secretField")).toBe("value");
  });
});
