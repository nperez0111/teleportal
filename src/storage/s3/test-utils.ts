import { S3Http, type S3Config } from "./client";

/**
 * S3-compatible endpoint for integration tests. Defaults match
 * `docker run -p 9000:9000 minio/minio server /data`.
 */
export const TEST_S3_CONFIG: S3Config = {
  endpoint: process.env.TEST_S3_ENDPOINT || "http://localhost:9000",
  bucket: process.env.TEST_S3_BUCKET || "teleportal-test",
  region: process.env.TEST_S3_REGION || "us-east-1",
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID || "minioadmin",
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY || "minioadmin",
  pathStyle: true,
  retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 50, requestTimeoutMs: 2000 },
};

/**
 * Ping the S3 endpoint (creating the test bucket when missing). Test files
 * check this in `beforeAll` and early-return from each test when unavailable,
 * mirroring the Redis transport tests.
 */
export async function isS3Available(): Promise<boolean> {
  try {
    const client = new S3Http(TEST_S3_CONFIG);
    await client.ensureBucket();
    await client.listObjectsV2("", { maxKeys: 1 });
    return true;
  } catch (error) {
    console.log(`S3 not available at ${TEST_S3_CONFIG.endpoint}: ${error}`);
    return false;
  }
}

/** A unique key prefix per test run so parallel runs never collide. */
export function randomS3Prefix(): string {
  return `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/`;
}
