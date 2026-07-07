import { AwsClient } from "aws4fetch";

export interface S3RetryOptions {
  /** Total attempts per request (first try included). Defaults to 3. */
  attempts?: number;
  /** Base delay for exponential backoff. Defaults to 100ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Defaults to 5000ms. */
  maxDelayMs?: number;
  /** Per-attempt timeout; a hung socket counts as a retryable failure. Defaults to 30s. */
  requestTimeoutMs?: number;
}

export interface S3Config {
  /**
   * Endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`,
   * `https://s3.us-east-1.amazonaws.com`, or `http://localhost:9000` (MinIO).
   */
  endpoint: string;
  bucket: string;
  /** SigV4 region. Use `"auto"` for R2. Defaults to `us-east-1`. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /**
   * `true` (default) addresses objects as `{endpoint}/{bucket}/{key}` —
   * required by MinIO and fine for R2/AWS. Set `false` for
   * virtual-hosted-style addressing where the bucket is part of the host.
   */
  pathStyle?: boolean;
  retry?: S3RetryOptions;
}

/** A non-retryable or retry-exhausted S3 failure. */
export class S3Error extends Error {
  readonly op: string;
  readonly status: number;
  readonly code?: string;
  readonly key?: string;

  constructor(op: string, status: number, message: string, code?: string, key?: string) {
    super(`S3 ${op} failed (${status}${code ? ` ${code}` : ""}): ${message}`);
    this.name = "S3Error";
    this.op = op;
    this.status = status;
    this.code = code;
    this.key = key;
  }
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: number;
}

export interface S3ListResult {
  objects: S3ObjectInfo[];
  commonPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface S3HeadResult {
  size: number;
  lastModified: number;
  /** User metadata from `x-amz-meta-*` headers, keys lowercased without the prefix. */
  meta: Record<string, string>;
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DELETE_BATCH_SIZE = 1000;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Extract the text of every `<tag>...</tag>` occurrence in `xml`. */
function xmlValues(xml: string, tag: string): string[] {
  const matches = xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"));
  return Array.from(matches, (m) => xmlUnescape(m[1]));
}

function xmlValue(xml: string, tag: string): string | undefined {
  return xmlValues(xml, tag)[0];
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Thin S3 REST client over aws4fetch (SigV4 signing only — ~6KB, zero deps).
 * Works with AWS S3, Cloudflare R2, and MinIO. Owns retries: network errors,
 * timeouts, 429 and 5xx are retried with exponential backoff + jitter
 * (honoring Retry-After); each attempt is re-signed with a fresh date and
 * bounded by `requestTimeoutMs`. 400/403/404/409 never retry.
 */
export class S3Http {
  readonly bucket: string;
  readonly endpoint: string;
  readonly #aws: AwsClient;
  readonly #baseUrl: string;
  readonly #attempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #requestTimeoutMs: number;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.#aws = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      service: "s3",
      region: config.region ?? "us-east-1",
      retries: 0,
    });
    const pathStyle = config.pathStyle ?? true;
    if (pathStyle) {
      this.#baseUrl = `${this.endpoint}/${config.bucket}`;
    } else {
      const url = new URL(this.endpoint);
      url.host = `${config.bucket}.${url.host}`;
      this.#baseUrl = url.toString().replace(/\/+$/, "");
    }
    this.#attempts = config.retry?.attempts ?? 3;
    this.#baseDelayMs = config.retry?.baseDelayMs ?? 100;
    this.#maxDelayMs = config.retry?.maxDelayMs ?? 5000;
    this.#requestTimeoutMs = config.retry?.requestTimeoutMs ?? 30_000;
  }

  async putObject(
    key: string,
    body: Uint8Array,
    options: { contentType?: string; meta?: Record<string, string> } = {},
  ): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": options.contentType ?? "application/octet-stream",
    };
    for (const [name, value] of Object.entries(options.meta ?? {})) {
      headers[`x-amz-meta-${name}`] = value;
    }
    const response = await this.#request("putObject", "PUT", this.#objectUrl(key), {
      body,
      headers,
      key,
    });
    await response.body?.cancel();
  }

  /** Returns null when the object does not exist. */
  async getObject(key: string): Promise<Uint8Array | null> {
    const response = await this.#request("getObject", "GET", this.#objectUrl(key), {
      key,
      allow404: true,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Returns null when the object does not exist. */
  async headObject(key: string): Promise<S3HeadResult | null> {
    const response = await this.#request("headObject", "HEAD", this.#objectUrl(key), {
      key,
      allow404: true,
    });
    await response.body?.cancel();
    if (response.status === 404) return null;
    const meta: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.startsWith("x-amz-meta-")) {
        meta[name.slice("x-amz-meta-".length)] = value;
      }
    });
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      lastModified: Date.parse(response.headers.get("last-modified") ?? "") || 0,
      meta,
    };
  }

  /** Deleting a missing object is a no-op (matches S3 semantics). */
  async deleteObject(key: string): Promise<void> {
    const response = await this.#request("deleteObject", "DELETE", this.#objectUrl(key), {
      key,
      allow404: true,
    });
    await response.body?.cancel();
  }

  /**
   * Batch delete, 1000 keys per request. Falls back to bounded-parallel
   * single deletes when the server insists on Content-MD5 (WebCrypto has no
   * MD5; AWS accepts x-amz-checksum-sha256 since 2022, R2 needs neither).
   */
  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${batch
        .map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`)
        .join("")}</Delete>`;
      const body = new TextEncoder().encode(xml);
      const checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
      let response: Response;
      try {
        response = await this.#request("deleteObjects", "POST", `${this.#baseUrl}?delete`, {
          body,
          headers: {
            "content-type": "application/xml",
            "x-amz-checksum-sha256": btoa(String.fromCharCode(...checksum)),
          },
        });
      } catch (error) {
        if (
          error instanceof S3Error &&
          error.status === 400 &&
          /content-?md5/i.test(error.message)
        ) {
          await mapLimit(batch, 8, (key) => this.deleteObject(key));
          continue;
        }
        throw error;
      }
      const text = await response.text();
      const errorCode = xmlValue(text, "Code");
      if (errorCode) {
        throw new S3Error(
          "deleteObjects",
          response.status,
          xmlValue(text, "Message") ?? "partial batch delete failure",
          errorCode,
          xmlValue(text, "Key"),
        );
      }
    }
  }

  async listObjectsV2(
    prefix: string,
    options: { delimiter?: string; continuationToken?: string; maxKeys?: number } = {},
  ): Promise<S3ListResult> {
    const query = new URLSearchParams({ "list-type": "2", prefix });
    if (options.delimiter) query.set("delimiter", options.delimiter);
    if (options.continuationToken) query.set("continuation-token", options.continuationToken);
    if (options.maxKeys) query.set("max-keys", String(options.maxKeys));
    const response = await this.#request(
      "listObjectsV2",
      "GET",
      `${this.#baseUrl}?${query.toString()}`,
      {},
    );
    const text = await response.text();
    const objects = Array.from(
      text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g),
      ([, block]): S3ObjectInfo => ({
        key: xmlValue(block, "Key") ?? "",
        size: Number(xmlValue(block, "Size") ?? 0),
        lastModified: Date.parse(xmlValue(block, "LastModified") ?? "") || 0,
      }),
    );
    const commonPrefixes = Array.from(
      text.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g),
      ([, block]) => xmlValue(block, "Prefix") ?? "",
    );
    return {
      objects,
      commonPrefixes,
      isTruncated: xmlValue(text, "IsTruncated") === "true",
      nextContinuationToken: xmlValue(text, "NextContinuationToken"),
    };
  }

  /** Paginate {@link listObjectsV2} until exhausted. */
  async listAll(
    prefix: string,
    options: { delimiter?: string } = {},
  ): Promise<{ objects: S3ObjectInfo[]; commonPrefixes: string[] }> {
    const objects: S3ObjectInfo[] = [];
    const commonPrefixes: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page: S3ListResult = await this.listObjectsV2(prefix, {
        ...options,
        continuationToken,
      });
      objects.push(...page.objects);
      commonPrefixes.push(...page.commonPrefixes);
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
    return { objects, commonPrefixes };
  }

  /**
   * Server-side copy within the bucket — object bytes never leave S3.
   * User metadata is carried along (copy directive defaults to COPY).
   */
  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    const response = await this.#request("copyObject", "PUT", this.#objectUrl(destinationKey), {
      headers: {
        "x-amz-copy-source": `/${this.bucket}/${encodeKey(sourceKey)}`,
      },
      key: destinationKey,
    });
    // CopyObject can return 200 with an error payload in the body.
    const text = await response.text();
    const errorCode = xmlValue(text, "Code");
    if (errorCode) {
      throw new S3Error(
        "copyObject",
        response.status,
        xmlValue(text, "Message") ?? "copy failed after 200 OK",
        errorCode,
        sourceKey,
      );
    }
  }

  /**
   * Create the bucket if it does not exist (mainly for MinIO/dev setups;
   * production buckets are usually provisioned out of band). Treats
   * already-exists responses as success.
   */
  async ensureBucket(): Promise<void> {
    try {
      const response = await this.#request("createBucket", "PUT", this.#baseUrl, {});
      await response.body?.cancel();
    } catch (error) {
      if (
        error instanceof S3Error &&
        (error.code === "BucketAlreadyOwnedByYou" || error.code === "BucketAlreadyExists")
      ) {
        return;
      }
      throw error;
    }
  }

  #objectUrl(key: string): string {
    return `${this.#baseUrl}/${encodeKey(key)}`;
  }

  async #request(
    op: string,
    method: string,
    url: string,
    options: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      key?: string;
      allow404?: boolean;
    },
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.#attempts; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
        const jittered = backoff * (0.5 + Math.random() * 0.5);
        const retryAfter =
          lastError instanceof RetryableResponseError ? lastError.retryAfterMs : undefined;
        await new Promise((resolve) => setTimeout(resolve, Math.max(jittered, retryAfter ?? 0)));
      }
      let response: Response;
      try {
        // Re-sign every attempt: SigV4 signatures embed the request date.
        const signed = await this.#aws.sign(url, {
          method,
          headers: options.headers,
          body: options.body as BodyInit | undefined,
        });
        response = await fetch(signed, {
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
      } catch (error) {
        // Network failure or timeout — retryable.
        lastError = error;
        continue;
      }
      if (response.ok || (options.allow404 && response.status === 404)) {
        return response;
      }
      const text = await response.text().catch(() => "");
      const code = xmlValue(text, "Code");
      const message = xmlValue(text, "Message") ?? text.slice(0, 200) ?? response.statusText;
      if (RETRYABLE_STATUS.has(response.status) || code === "SlowDown") {
        lastError = new RetryableResponseError(
          new S3Error(op, response.status, message, code, options.key),
          parseRetryAfter(response.headers.get("retry-after")),
        );
        continue;
      }
      throw new S3Error(op, response.status, message, code, options.key);
    }
    if (lastError instanceof RetryableResponseError) throw lastError.cause;
    throw new S3Error(
      op,
      0,
      `request failed after ${this.#attempts} attempts: ${lastError}`,
      undefined,
      options.key,
    );
  }
}

/** Internal marker wrapping a retryable HTTP failure with its Retry-After. */
class RetryableResponseError extends Error {
  constructor(
    override readonly cause: S3Error,
    readonly retryAfterMs?: number,
  ) {
    super(cause.message);
  }
}

/** Encode an object key for a URL path, preserving `/` separators. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
