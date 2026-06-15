import { describe, expect, it } from "bun:test";
import {
  changesetContentMap,
  createContentAttribute,
  createContentIds,
  createContentMapFromContentIds,
  getActivity,
  mergeContentMaps,
  milestoneContentMap,
  type ContentIds,
  type ContentMap,
} from "./index";

/** A ContentMap attributing client `client`'s ops [0,len) to `user` at `t`. */
function userMap(
  client: number,
  len: number,
  user: string,
  t: number,
): ContentMap {
  const ids = createContentIds();
  ids.inserts.add(client, 0, len);
  return createContentMapFromContentIds(ids, [
    createContentAttribute("insert", user),
    createContentAttribute("insertAt", t),
  ]);
}

function ids(...ranges: [client: number, len: number][]): ContentIds {
  const c = createContentIds();
  for (const [client, len] of ranges) c.inserts.add(client, 0, len);
  return c;
}

function users(map: ContentMap): string[] {
  return [...new Set(getActivity(map).map((e) => e.userId))].sort() as string[];
}

describe("milestoneContentMap", () => {
  const full = mergeContentMaps([
    userMap(1, 6, "user-1", 1000),
    userMap(2, 5, "user-2", 2000),
  ]);

  it("keeps only content present in the milestone", () => {
    // Milestone with only client 1's content.
    expect(users(milestoneContentMap(full, ids([1, 6])))).toEqual(["user-1"]);
    // Milestone with both clients' content.
    expect(users(milestoneContentMap(full, ids([1, 6], [2, 5])))).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("drops attribution for ops not in the milestone", () => {
    const scoped = milestoneContentMap(full, ids([1, 6]));
    expect(scoped.inserts.clients.has(2)).toBe(false);
  });
});

describe("changesetContentMap", () => {
  const full = mergeContentMaps([
    userMap(1, 6, "user-1", 1000),
    userMap(2, 5, "user-2", 2000),
  ]);

  it("keeps only the operations added between two milestones", () => {
    const from = ids([1, 6]); // milestone A: user-1 only
    const to = ids([1, 6], [2, 5]); // milestone B: both
    expect(users(changesetContentMap(full, from, to))).toEqual(["user-2"]);
  });

  it("is empty when nothing changed between milestones", () => {
    const same = ids([1, 6]);
    expect(users(changesetContentMap(full, same, same))).toEqual([]);
  });
});
