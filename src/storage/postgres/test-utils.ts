import postgres from "postgres";

import type { Sql } from "./types";

/**
 * Connection string for integration tests. CI and local runs may point this
 * anywhere; the default matches `docker run -e POSTGRES_PASSWORD=postgres
 * -p 5432:5432 postgres:17-alpine`.
 */
export const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ||
  process.env.POSTGRES_URL ||
  "postgres://postgres:postgres@localhost:5432/postgres";

/**
 * Ping Postgres with a short timeout. Test files check this in `beforeAll`
 * and early-return from each test when unavailable, mirroring the Redis
 * transport tests.
 */
export async function isPostgresAvailable(): Promise<boolean> {
  const sql = postgres(POSTGRES_URL, { max: 1, connect_timeout: 2 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (error) {
    console.log(`Postgres not available at ${POSTGRES_URL}: ${error}`);
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * A unique, valid table prefix per test run so parallel runs against a
 * shared database never collide.
 */
export function randomTablePrefix(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `tp_test_${Date.now().toString(36)}_${rand}_`;
}

/** Create a pooled client for tests. Callers must `end()` it in afterAll. */
export function makeTestSql(max: number = 4): Sql & { end(): Promise<void> } {
  const sql = postgres(POSTGRES_URL, { max, onnotice: () => {} });
  return sql as unknown as Sql & { end(): Promise<void> };
}
