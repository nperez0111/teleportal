import { describe, expect, it, beforeEach } from "bun:test";
import { TtlDedupe } from "./dedupe";

describe("TtlDedupe", () => {
  let dedupe: TtlDedupe;

  beforeEach(() => {
    dedupe = new TtlDedupe();
  });

  describe("constructor", () => {
    it("should create a TtlDedupe instance with default options", () => {
      expect(dedupe).toBeDefined();
    });

    it("should create a TtlDedupe instance with custom ttlMs", () => {
      const customDedupe = new TtlDedupe({ ttlMs: 60_000 });
      expect(customDedupe).toBeDefined();
    });

    it("should create a TtlDedupe instance with custom maxPerDoc", () => {
      const customDedupe = new TtlDedupe({ maxPerDoc: 500 });
      expect(customDedupe).toBeDefined();
    });

    it("should create a TtlDedupe instance with custom options", () => {
      const customDedupe = new TtlDedupe({ ttlMs: 60_000, maxPerDoc: 500 });
      expect(customDedupe).toBeDefined();
    });
  });

  describe("shouldAccept", () => {
    it("should accept a new message", () => {
      const result = dedupe.shouldAccept("doc-1", "msg-1");
      expect(result).toBe(true);
    });

    it("should reject a duplicate message", () => {
      dedupe.shouldAccept("doc-1", "msg-1");
      const result = dedupe.shouldAccept("doc-1", "msg-1");
      expect(result).toBe(false);
    });

    it("should accept different messages for the same document", () => {
      dedupe.shouldAccept("doc-1", "msg-1");
      const result = dedupe.shouldAccept("doc-1", "msg-2");
      expect(result).toBe(true);
    });

    it("should accept same message ID for different documents", () => {
      dedupe.shouldAccept("doc-1", "msg-1");
      const result = dedupe.shouldAccept("doc-2", "msg-1");
      expect(result).toBe(true);
    });

    it("should prune expired messages", async () => {
      const shortTtlDedupe = new TtlDedupe({ ttlMs: 50 });
      shortTtlDedupe.shouldAccept("doc-1", "msg-1");
      
      // Wait for message to expire
      await new Promise((resolve) => setTimeout(resolve, 60));
      
      // Should accept again after expiration
      const result = shortTtlDedupe.shouldAccept("doc-1", "msg-1");
      expect(result).toBe(true);
    });

    it("should enforce maxPerDoc limit", () => {
      const smallMaxDedupe = new TtlDedupe({ maxPerDoc: 3 });
      
      // Add messages up to the limit
      smallMaxDedupe.shouldAccept("doc-1", "msg-1");
      smallMaxDedupe.shouldAccept("doc-1", "msg-2");
      smallMaxDedupe.shouldAccept("doc-1", "msg-3");
      
      // Should still accept new messages (oldest will be pruned)
      const result = smallMaxDedupe.shouldAccept("doc-1", "msg-4");
      expect(result).toBe(true);
      
      // Oldest message should be pruned
      const oldestResult = smallMaxDedupe.shouldAccept("doc-1", "msg-1");
      expect(oldestResult).toBe(true);
    });
  });

  describe("clearDocument", () => {
    it("should clear all messages for a document", () => {
      dedupe.shouldAccept("doc-1", "msg-1");
      dedupe.shouldAccept("doc-1", "msg-2");
      dedupe.shouldAccept("doc-2", "msg-1");
      
      dedupe.clearDocument("doc-1");
      
      // Messages for doc-1 should be cleared
      expect(dedupe.shouldAccept("doc-1", "msg-1")).toBe(true);
      expect(dedupe.shouldAccept("doc-1", "msg-2")).toBe(true);
      
      // Messages for doc-2 should still be there
      expect(dedupe.shouldAccept("doc-2", "msg-1")).toBe(false);
    });

    it("should not throw when clearing non-existent document", () => {
      expect(() => dedupe.clearDocument("non-existent")).not.toThrow();
    });
  });

  describe("clearAll", () => {
    it("should clear all messages for all documents", () => {
      dedupe.shouldAccept("doc-1", "msg-1");
      dedupe.shouldAccept("doc-1", "msg-2");
      dedupe.shouldAccept("doc-2", "msg-1");
      dedupe.shouldAccept("doc-3", "msg-1");
      
      dedupe.clearAll();
      
      // All messages should be cleared
      expect(dedupe.shouldAccept("doc-1", "msg-1")).toBe(true);
      expect(dedupe.shouldAccept("doc-1", "msg-2")).toBe(true);
      expect(dedupe.shouldAccept("doc-2", "msg-1")).toBe(true);
      expect(dedupe.shouldAccept("doc-3", "msg-1")).toBe(true);
    });

    it("should work with empty dedupe", () => {
      expect(() => dedupe.clearAll()).not.toThrow();
    });
  });
});

