import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { AdvisoryLocker, LockTimeoutError } from "./lock";
import { isPostgresAvailable, makeTestSql } from "./test-utils";
import type { ReservedSql, Sql } from "./types";

let available = false;
let sql: (Sql & { end(): Promise<void> }) | undefined;
const namespace = `lock_test_${Date.now().toString(36)}`;

beforeAll(async () => {
  available = await isPostgresAvailable();
  if (!available) return;
  sql = makeTestSql(10);
});

afterAll(async () => {
  if (sql) await sql.end();
});

/** Compute the same bigint advisory-lock key the locker uses for a given key. */
async function advisoryKey(client: Sql, ns: string, key: string): Promise<bigint> {
  const rows = (await client`SELECT hashtextextended(${`${ns}:${key}`}, 0) AS k`) as {
    k: bigint | string;
  }[];
  return BigInt(rows[0].k);
}

describe("AdvisoryLocker", () => {
  it("serializes concurrent callers on the same key in-process", async () => {
    if (!available) return;
    const locker = new AdvisoryLocker(sql!, namespace);
    const key = `k-${crypto.randomUUID()}`;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        locker.withLock(key, async () => {
          order.push(i);
          await new Promise((r) => setTimeout(r, 1));
          order.push(i);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe(order[i + 1]);
    }
    await locker.close();
  });

  it("does not stall an unrelated key while another key is contended cross-session", async () => {
    if (!available) return;
    // A separate session holds key "b"'s advisory lock for the whole test.
    // Under the old blocking design, the locker's single shared connection
    // would issue pg_advisory_lock(b) and block server-side, wedging the
    // connection so key "a"'s unlock/re-acquire could never reach Postgres.
    const locker = new AdvisoryLocker(sql!, namespace, { lockTimeoutMs: 30_000 });
    const keyA = `a-${crypto.randomUUID()}`;
    const keyB = `b-${crypto.randomUUID()}`;

    const external: ReservedSql = await sql!.reserve();
    try {
      const bKey = await advisoryKey(external, namespace, keyB);
      await external`SELECT pg_advisory_lock(${bKey})`;

      // Kick off a contended acquisition of key "b" through the locker. It can
      // never succeed while the external session holds it — it must simply not
      // block key "a".
      let bSettled = false;
      const bAttempt = locker
        .withLock(keyB, async () => "b")
        .then(
          () => {
            bSettled = true;
          },
          () => {
            bSettled = true;
          },
        );

      // Give the b attempt a moment to enter its acquisition path.
      await new Promise((r) => setTimeout(r, 5));

      // Key "a" must acquire, run, release, and re-acquire promptly despite the
      // stuck b acquisition sharing the same connection.
      const start = Date.now();
      expect(await locker.withLock(keyA, async () => "a1")).toBe("a1");
      expect(await locker.withLock(keyA, async () => "a2")).toBe("a2");
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);

      // b is still stuck (external session still holds it).
      expect(bSettled).toBe(false);

      // Release the external lock so the pending b acquisition can finish and
      // we don't leak a hanging promise.
      await external`SELECT pg_advisory_unlock(${bKey})`;
      await bAttempt;
    } finally {
      external.release();
      await locker.close();
    }
  });

  it("times out with LockTimeoutError on a wedged cross-session holder", async () => {
    if (!available) return;
    const locker = new AdvisoryLocker(sql!, namespace, { lockTimeoutMs: 50 });
    const key = `t-${crypto.randomUUID()}`;
    const external: ReservedSql = await sql!.reserve();
    try {
      const k = await advisoryKey(external, namespace, key);
      await external`SELECT pg_advisory_lock(${k})`;
      await expect(locker.withLock(key, async () => "never")).rejects.toThrow(LockTimeoutError);
      await external`SELECT pg_advisory_unlock(${k})`;
      // After release the same locker acquires successfully.
      expect(await locker.withLock(key, async () => "ok")).toBe("ok");
    } finally {
      external.release();
      await locker.close();
    }
  });
});
