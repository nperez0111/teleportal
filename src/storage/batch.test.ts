import { describe, expect, it } from "bun:test";
import { batch } from "./batch";

describe("batch", () => {
  it("fires when maxSize is reached", () => {
    const batches: number[][] = [];
    const add = batch<number>((items) => batches.push(items), { maxSize: 3 });

    add(1);
    add(2);
    expect(batches).toHaveLength(0);
    add(3);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([1, 2, 3]);
  });

  it("fires after wait timeout", async () => {
    const batches: number[][] = [];
    const add = batch<number>((items) => batches.push(items), { wait: 1 });

    add(1);
    add(2);
    expect(batches).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([1, 2]);
  });

  it("does not fire for empty batch", async () => {
    const batches: number[][] = [];
    batch<number>((items) => batches.push(items), { wait: 1 });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(batches).toHaveLength(0);
  });

  it("resets after maxSize flush and continues batching", () => {
    const batches: number[][] = [];
    const add = batch<number>((items) => batches.push(items), { maxSize: 2 });

    add(1);
    add(2);
    expect(batches).toHaveLength(1);

    add(3);
    add(4);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([3, 4]);
  });
});
