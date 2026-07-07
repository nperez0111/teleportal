import { afterEach, describe, expect, it } from "bun:test";

import { S3Error, S3Http, mapLimit } from "./client";

type StubHandler = (request: Request) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;
const requests: Request[] = [];

/** Queue per-call handlers; the last one handles all remaining calls. */
function stubFetch(...handlers: StubHandler[]) {
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const handler = handlers[Math.min(call++, handlers.length - 1)];
    return handler(request);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  requests.length = 0;
});

function makeClient(retry?: ConstructorParameters<typeof S3Http>[0]["retry"]) {
  return new S3Http({
    endpoint: "http://s3.test",
    bucket: "bucket",
    accessKeyId: "key",
    secretAccessKey: "secret",
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, ...retry },
  });
}

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status: 200 });

describe("S3Http", () => {
  describe("retries", () => {
    it("retries 503 and succeeds", async () => {
      stubFetch(
        () => new Response("busy", { status: 503 }),
        () => new Response(new Uint8Array([1, 2, 3])),
      );
      const bytes = await makeClient().getObject("k");
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(requests).toHaveLength(2);
    });

    it("retries 429 and honors Retry-After seconds", async () => {
      const start = Date.now();
      stubFetch(
        () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
        () => new Response(new Uint8Array([1])),
      );
      await makeClient().getObject("k");
      expect(requests).toHaveLength(2);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("does not retry 403", async () => {
      stubFetch(
        () =>
          new Response("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>", {
            status: 403,
          }),
      );
      await expect(makeClient().getObject("k")).rejects.toThrow(S3Error);
      expect(requests).toHaveLength(1);
    });

    it("gives up after the configured attempts", async () => {
      stubFetch(() => new Response("busy", { status: 503 }));
      await expect(makeClient().getObject("k")).rejects.toThrow(/503/);
      expect(requests).toHaveLength(3);
    });

    it("retries network errors", async () => {
      stubFetch(
        () => {
          throw new Error("ECONNRESET");
        },
        () => new Response(new Uint8Array([7])),
      );
      expect(await makeClient().getObject("k")).toEqual(new Uint8Array([7]));
    });

    it("re-signs each attempt with a fresh request", async () => {
      stubFetch(
        () => new Response("busy", { status: 503 }),
        () => new Response(new Uint8Array([1])),
      );
      await makeClient().getObject("k");
      const [first, second] = requests;
      expect(first.headers.get("authorization")).toBeTruthy();
      expect(second.headers.get("authorization")).toBeTruthy();
    });
  });

  describe("object operations", () => {
    it("returns null for a missing object and missing head", async () => {
      stubFetch(() => new Response("nope", { status: 404 }));
      const client = makeClient();
      expect(await client.getObject("missing")).toBeNull();
      expect(await client.headObject("missing")).toBeNull();
    });

    it("sends user metadata as x-amz-meta headers and reads it back", async () => {
      stubFetch(
        () => new Response(null, { status: 200 }),
        () =>
          new Response(null, {
            status: 200,
            headers: {
              "content-length": "5",
              "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
              "x-amz-meta-leaf-hash": "abc123",
            },
          }),
      );
      const client = makeClient();
      await client.putObject("k", new Uint8Array([1]), { meta: { "leaf-hash": "abc123" } });
      expect(requests[0].headers.get("x-amz-meta-leaf-hash")).toBe("abc123");
      const head = await client.headObject("k");
      expect(head?.meta["leaf-hash"]).toBe("abc123");
      expect(head?.size).toBe(5);
      expect(head?.lastModified).toBe(Date.parse("Wed, 01 Jan 2025 00:00:00 GMT"));
    });

    it("percent-encodes key segments but keeps separators", async () => {
      stubFetch(() => new Response(new Uint8Array([1])));
      await makeClient().getObject("a/b+c/d e");
      expect(new URL(requests[0].url).pathname).toBe("/bucket/a/b%2Bc/d%20e");
    });
  });

  describe("listObjectsV2", () => {
    it("parses contents, escaped keys, and common prefixes", async () => {
      stubFetch(() =>
        xml(`<ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <Contents><Key>files/a&amp;b</Key><Size>10</Size><LastModified>2025-01-01T00:00:00.000Z</LastModified></Contents>
          <Contents><Key>files/two</Key><Size>20</Size><LastModified>2025-01-02T00:00:00.000Z</LastModified></Contents>
          <CommonPrefixes><Prefix>uploads/one/</Prefix></CommonPrefixes>
        </ListBucketResult>`),
      );
      const result = await makeClient().listObjectsV2("files/");
      expect(result.objects).toEqual([
        { key: "files/a&b", size: 10, lastModified: Date.parse("2025-01-01T00:00:00.000Z") },
        { key: "files/two", size: 20, lastModified: Date.parse("2025-01-02T00:00:00.000Z") },
      ]);
      expect(result.commonPrefixes).toEqual(["uploads/one/"]);
      expect(result.isTruncated).toBe(false);
    });

    it("paginates with listAll", async () => {
      stubFetch(
        () =>
          xml(`<ListBucketResult>
            <IsTruncated>true</IsTruncated>
            <NextContinuationToken>tok1</NextContinuationToken>
            <Contents><Key>a</Key><Size>1</Size><LastModified>2025-01-01T00:00:00Z</LastModified></Contents>
          </ListBucketResult>`),
        () =>
          xml(`<ListBucketResult>
            <IsTruncated>false</IsTruncated>
            <Contents><Key>b</Key><Size>2</Size><LastModified>2025-01-01T00:00:00Z</LastModified></Contents>
          </ListBucketResult>`),
      );
      const { objects } = await makeClient().listAll("");
      expect(objects.map((o) => o.key)).toEqual(["a", "b"]);
      expect(new URL(requests[1].url).searchParams.get("continuation-token")).toBe("tok1");
    });
  });

  describe("deleteObjects", () => {
    it("sends an escaped XML batch with a sha256 checksum", async () => {
      stubFetch(() => xml(`<DeleteResult></DeleteResult>`));
      await makeClient().deleteObjects(["a&b", "c<d"]);
      const body = await requests[0].text();
      expect(body).toContain("<Key>a&amp;b</Key>");
      expect(body).toContain("<Key>c&lt;d</Key>");
      expect(requests[0].headers.get("x-amz-checksum-sha256")).toBeTruthy();
      expect(new URL(requests[0].url).search).toBe("?delete");
    });

    it("falls back to single deletes when Content-MD5 is required", async () => {
      stubFetch(
        () =>
          new Response(
            "<Error><Code>InvalidRequest</Code><Message>Missing required header for this request: Content-MD5</Message></Error>",
            { status: 400 },
          ),
        () => new Response(null, { status: 204 }),
      );
      await makeClient().deleteObjects(["x", "y"]);
      // 1 failed batch + 2 single deletes.
      expect(requests).toHaveLength(3);
      expect(requests[1].method).toBe("DELETE");
      expect(requests[2].method).toBe("DELETE");
    });

    it("throws when the batch reports per-key errors", async () => {
      stubFetch(() =>
        xml(
          `<DeleteResult><Error><Key>bad</Key><Code>InternalError</Code><Message>oops</Message></Error></DeleteResult>`,
        ),
      );
      await expect(makeClient().deleteObjects(["bad"])).rejects.toThrow(/InternalError|oops/);
    });
  });

  describe("copyObject", () => {
    it("sends x-amz-copy-source and succeeds on a clean 200", async () => {
      stubFetch(() => xml(`<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>`));
      await makeClient().copyObject("src/k", "dst/k");
      expect(requests[0].headers.get("x-amz-copy-source")).toBe("/bucket/src/k");
      expect(requests[0].method).toBe("PUT");
    });

    it("detects an error payload inside a 200 response", async () => {
      stubFetch(() =>
        xml(`<Error><Code>InternalError</Code><Message>copy blew up</Message></Error>`),
      );
      await expect(makeClient().copyObject("a", "b")).rejects.toThrow(/copy blew up/);
    });
  });

  describe("mapLimit", () => {
    it("bounds concurrency and preserves order", async () => {
      let inFlight = 0;
      let peak = 0;
      const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return n * 10;
      });
      expect(results).toEqual([10, 20, 30, 40, 50, 60]);
      expect(peak).toBeLessThanOrEqual(2);
    });
  });
});
