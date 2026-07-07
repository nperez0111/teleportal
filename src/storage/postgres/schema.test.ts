import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  buildSchemaSql,
  dropSchema,
  ensureSchema,
  validateTablePrefix,
} from "./schema";
import { isPostgresAvailable, makeTestSql, randomTablePrefix } from "./test-utils";
import type { Sql } from "./types";

let available = false;
let sql: (Sql & { end(): Promise<void> }) | undefined;

beforeAll(async () => {
  available = await isPostgresAvailable();
  if (!available) return;
  sql = makeTestSql(2);
});

afterAll(async () => {
  await sql?.end();
});

describe("validateTablePrefix", () => {
  it("accepts lowercase identifiers", () => {
    expect(validateTablePrefix("teleportal_")).toBe("teleportal_");
    expect(validateTablePrefix("_x9_")).toBe("_x9_");
  });

  it("rejects unsafe prefixes", () => {
    expect(() => validateTablePrefix("Bad")).toThrow();
    expect(() => validateTablePrefix("9start")).toThrow();
    expect(() => validateTablePrefix('a"; DROP TABLE users; --')).toThrow();
    expect(() => validateTablePrefix("a".repeat(41))).toThrow();
  });
});

describe("buildSchemaSql", () => {
  it("embeds the prefix into every statement", () => {
    const statements = buildSchemaSql("myprefix_");
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toContain("myprefix_");
    }
  });

  it("exports a combined SCHEMA_SQL script with the version stamp", () => {
    expect(SCHEMA_SQL).toContain("schema_meta");
    expect(SCHEMA_SQL).toContain(String(SCHEMA_VERSION));
  });
});

describe("ensureSchema", () => {
  it("is idempotent and records the schema version", async () => {
    if (!available) return;
    const prefix = randomTablePrefix();
    try {
      await ensureSchema(sql!, { tablePrefix: prefix });
      await ensureSchema(sql!, { tablePrefix: prefix });
      const rows = (await sql!.unsafe(`SELECT version FROM ${prefix}schema_meta WHERE id = 1`)) as {
        version: number;
      }[];
      expect(Number(rows[0].version)).toBe(SCHEMA_VERSION);
    } finally {
      await dropSchema(sql!, { tablePrefix: prefix });
    }
  });

  it("throws on a schema version mismatch", async () => {
    if (!available) return;
    const prefix = randomTablePrefix();
    try {
      await ensureSchema(sql!, { tablePrefix: prefix });
      await sql!.unsafe(`UPDATE ${prefix}schema_meta SET version = 999 WHERE id = 1`);
      await expect(ensureSchema(sql!, { tablePrefix: prefix })).rejects.toThrow(
        /schema version mismatch/,
      );
    } finally {
      await dropSchema(sql!, { tablePrefix: prefix });
    }
  });

  it("dropSchema removes all tables so ensureSchema can recreate", async () => {
    if (!available) return;
    const prefix = randomTablePrefix();
    await ensureSchema(sql!, { tablePrefix: prefix });
    await dropSchema(sql!, { tablePrefix: prefix });
    const rows = (await sql!.unsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE '${prefix}%'`,
    )) as { table_name: string }[];
    expect(rows).toHaveLength(0);
    await ensureSchema(sql!, { tablePrefix: prefix });
    await dropSchema(sql!, { tablePrefix: prefix });
  });
});
