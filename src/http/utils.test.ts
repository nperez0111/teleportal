import { describe, expect, it } from "bun:test";
import { getDocumentsFromQueryParams } from "./utils";

describe("getDocumentsFromQueryParams", () => {
  it("should extract single document from query parameter", () => {
    const request = new Request("http://example.com/sse?documents=doc-1");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([{ document: "doc-1", encrypted: false }]);
  });

  it("should extract multiple documents from multiple query parameters", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1&documents=doc-2&documents=doc-3",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: false },
      { document: "doc-3", encrypted: false },
    ]);
  });

  it("should extract multiple documents from comma-separated values", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,doc-2,doc-3",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: false },
      { document: "doc-3", encrypted: false },
    ]);
  });

  it("should handle mixed format (multiple parameters and comma-separated)", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,doc-2&documents=doc-3&documents=doc-4,doc-5",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: false },
      { document: "doc-3", encrypted: false },
      { document: "doc-4", encrypted: false },
      { document: "doc-5", encrypted: false },
    ]);
  });

  it("should remove duplicates", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,doc-2&documents=doc-1&documents=doc-2,doc-3",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: false },
      { document: "doc-3", encrypted: false },
    ]);
  });

  it("should handle URL-encoded document names", () => {
    const encodedName1 = encodeURIComponent("doc with spaces");
    const encodedName2 = encodeURIComponent("doc/with/slashes");
    const request = new Request(
      `http://example.com/sse?documents=${encodedName1}&documents=${encodedName2}`,
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc with spaces", encrypted: false },
      { document: "doc/with/slashes", encrypted: false },
    ]);
  });

  it("should handle empty string parameters", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,&documents=,doc-2,&documents=",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: false },
    ]);
  });

  it("should return empty array when no documents parameter", () => {
    const request = new Request("http://example.com/sse");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([]);
  });

  it("should return empty array when documents parameter is empty", () => {
    const request = new Request("http://example.com/sse?documents=");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([]);
  });

  it("should handle special characters in document names", () => {
    const specialName = encodeURIComponent("doc-with-symbols!@#$%^&*()");
    const request = new Request(
      `http://example.com/sse?documents=${specialName}`,
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-with-symbols!@#$%^&*()", encrypted: false },
    ]);
  });

  it("should trim whitespace from document names", () => {
    const request = new Request(
      "http://example.com/sse?documents= doc-1 , doc-2 &documents= doc-3 ",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: false },
      { document: "doc-3", encrypted: false },
    ]);
  });

  it("should handle numeric document IDs", () => {
    const request = new Request(
      "http://example.com/sse?documents=123,456&documents=789",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "123", encrypted: false },
      { document: "456", encrypted: false },
      { document: "789", encrypted: false },
    ]);
  });

  it("should handle UUID-like document IDs", () => {
    const uuid1 = "550e8400-e29b-41d4-a716-446655440000";
    const uuid2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const request = new Request(
      `http://example.com/sse?documents=${uuid1}&documents=${uuid2}`,
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: uuid1, encrypted: false },
      { document: uuid2, encrypted: false },
    ]);
  });

  // New tests for encryption functionality
  it("should handle encrypted documents with suffix", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1:encrypted,doc-2,doc-3:encrypted",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: false },
      { document: "doc-3", encrypted: true },
    ]);
  });

  it("should handle encrypted documents in multiple parameters", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1:encrypted&documents=doc-2&documents=doc-3:encrypted",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: false },
      { document: "doc-3", encrypted: true },
    ]);
  });

  it("should prefer encrypted version when document appears both encrypted and unencrypted", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,doc-1:encrypted",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([{ document: "doc-1", encrypted: true }]);
  });

  it("should handle URL-encoded encrypted document names", () => {
    const encodedName = encodeURIComponent("doc with spaces");
    const request = new Request(
      `http://example.com/sse?documents=${encodedName}:encrypted`,
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([{ document: "doc with spaces", encrypted: true }]);
  });

  it("should ignore empty encrypted document names", () => {
    const request = new Request(
      "http://example.com/sse?documents=:encrypted,doc-1,doc-2:encrypted",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: true },
    ]);
  });
});
