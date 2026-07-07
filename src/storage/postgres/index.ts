/**
 * Postgres-backed storage adapters.
 *
 * All adapters take an injected client (`postgres` (porsager) or `Bun.sql` —
 * see {@link Sql}) and never manage the pool's lifecycle. Run
 * {@link ensureSchema} once at startup before constructing adapters.
 *
 * Note: `./test-utils` is intentionally not re-exported — it imports the
 * `postgres` package at runtime, which must not enter the published module
 * graph.
 */
export * from "./codec";
export * from "./document-storage";
export * from "./key-registry-storage";
export * from "./lock";
export * from "./milestone-storage";
export * from "./rate-limit-storage";
export * from "./schema";
export * from "./types";
