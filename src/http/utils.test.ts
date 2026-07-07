import { describe, expect, it } from "bun:test";
import { decodeHTTPRequest, getDocumentsFromQueryParams } from "./utils";

describe("getDocumentsFromQueryParams", () => {
  it("should extract single document from query parameter (encrypted by default)", () => {
    const request = new Request("http://example.com/sse?documents=doc-1");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([{ document: "doc-1", encrypted: true }]);
  });

  it("should extract multiple documents from multiple query parameters", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1&documents=doc-2&documents=doc-3",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: true },
      { document: "doc-3", encrypted: true },
    ]);
  });

  it("should extract multiple documents from comma-separated values", () => {
    const request = new Request("http://example.com/sse?documents=doc-1,doc-2,doc-3");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: true },
      { document: "doc-3", encrypted: true },
    ]);
  });

  it("should handle mixed format (multiple parameters and comma-separated)", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,doc-2&documents=doc-3&documents=doc-4,doc-5",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: true },
      { document: "doc-3", encrypted: true },
      { document: "doc-4", encrypted: true },
      { document: "doc-5", encrypted: true },
    ]);
  });

  it("should remove duplicates", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,doc-2&documents=doc-1&documents=doc-2,doc-3",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: true },
      { document: "doc-3", encrypted: true },
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
      { document: "doc with spaces", encrypted: true },
      { document: "doc/with/slashes", encrypted: true },
    ]);
  });

  it("should handle empty string parameters", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1,&documents=,doc-2,&documents=",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: true },
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
    const request = new Request(`http://example.com/sse?documents=${specialName}`);
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([{ document: "doc-with-symbols!@#$%^&*()", encrypted: true }]);
  });

  it("should trim whitespace from document names", () => {
    const request = new Request(
      "http://example.com/sse?documents= doc-1 , doc-2 &documents= doc-3 ",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: true },
      { document: "doc-3", encrypted: true },
    ]);
  });

  it("should handle numeric document IDs", () => {
    const request = new Request("http://example.com/sse?documents=123,456&documents=789");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "123", encrypted: true },
      { document: "456", encrypted: true },
      { document: "789", encrypted: true },
    ]);
  });

  it("should handle UUID-like document IDs", () => {
    const uuid1 = "550e8400-e29b-41d4-a716-446655440000";
    const uuid2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const request = new Request(`http://example.com/sse?documents=${uuid1}&documents=${uuid2}`);
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: uuid1, encrypted: true },
      { document: uuid2, encrypted: true },
    ]);
  });

  // Encryption is the default; ":plaintext" / ":unencrypted" opts a doc out.
  it("should opt documents out of encryption with a :plaintext suffix", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1:plaintext,doc-2,doc-3:plaintext",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: true },
      { document: "doc-3", encrypted: false },
    ]);
  });

  it("should accept :unencrypted as an alias for the opt-out suffix", () => {
    const request = new Request("http://example.com/sse?documents=doc-1:unencrypted,doc-2");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: true },
    ]);
  });

  it("should handle plaintext opt-out across multiple parameters", () => {
    const request = new Request(
      "http://example.com/sse?documents=doc-1:plaintext&documents=doc-2&documents=doc-3:plaintext",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: false },
      { document: "doc-2", encrypted: true },
      { document: "doc-3", encrypted: false },
    ]);
  });

  it("should prefer encrypted version when document appears both ways", () => {
    const request = new Request("http://example.com/sse?documents=doc-1:plaintext,doc-1");
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([{ document: "doc-1", encrypted: true }]);
  });

  it("should handle URL-encoded plaintext document names", () => {
    const encodedName = encodeURIComponent("doc with spaces");
    const request = new Request(`http://example.com/sse?documents=${encodedName}:plaintext`);
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([{ document: "doc with spaces", encrypted: false }]);
  });

  it("should ignore empty plaintext document names", () => {
    const request = new Request(
      "http://example.com/sse?documents=:plaintext,doc-1,doc-2:plaintext",
    );
    const result = getDocumentsFromQueryParams(request);
    expect(result).toEqual([
      { document: "doc-1", encrypted: true },
      { document: "doc-2", encrypted: false },
    ]);
  });
});

describe("decodeHTTPRequest", () => {
  it("should throw if x-teleportal-client-id header is missing", () => {
    const response = new Response(new ReadableStream(), {
      headers: {},
    });
    expect(() => decodeHTTPRequest(response)).toThrow(
      "Response is missing the x-teleportal-client-id header",
    );
  });

  it("should throw if response has no body", () => {
    const response = new Response(null, {
      headers: { "x-teleportal-client-id": "test-client" },
    });
    expect(() => decodeHTTPRequest(response)).toThrow("Response has no body");
  });

  it("should return an async iterable for a valid response", () => {
    const response = new Response(new ReadableStream(), {
      headers: { "x-teleportal-client-id": "test-client" },
    });
    const result = decodeHTTPRequest(response);
    expect(result).toBeDefined();
    expect(result[Symbol.asyncIterator]).toBeDefined();
  });
});
