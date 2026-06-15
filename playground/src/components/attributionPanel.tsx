import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { Milestone } from "teleportal";
import type { Provider } from "teleportal/providers";
import type { ActivityEntry, ContentMap } from "teleportal/attribution";
import { resolveRangeAttribution } from "teleportal/protocols/attribution";
import { colorForUser, getIdentity, setIdentity } from "../utils/identity";

interface AttributionPanelProps {
  provider: Provider | null;
  selectedMilestone: Milestone | null;
  isOpen: boolean;
  onClose: () => void;
}

interface CompositionSlice {
  userId: string;
  chars: number;
}

interface Contribution {
  userId: string;
  edits: number;
}

/** Accumulate, per author, how many characters of `node`'s text they wrote. */
function walkText(
  node: Y.XmlText | Y.XmlElement | Y.XmlFragment,
  map: ContentMap,
  byUser: Map<string, number>,
  totals: { total: number },
) {
  if (node instanceof Y.XmlText) {
    const len = node.length;
    if (len === 0) return;
    totals.total += len;
    for (const seg of resolveRangeAttribution(node, 0, len, map)) {
      const userId = seg.userId ?? "unknown";
      byUser.set(userId, (byUser.get(userId) ?? 0) + (seg.to - seg.from));
    }
    return;
  }
  for (const child of node.toArray()) {
    walkText(child as Y.XmlText | Y.XmlElement, map, byUser, totals);
  }
}

/** Collapse an activity timeline into a per-author edit count. */
function toContributions(activity: ActivityEntry[]): Contribution[] {
  const counts = new Map<string, number>();
  for (const entry of activity) {
    const userId = entry.userId ?? "unknown";
    counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([userId, edits]) => ({ userId, edits }))
    .sort((a, b) => b.edits - a.edits);
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function Avatar({ userId, size = 24 }: { userId: string; size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: colorForUser(userId),
        fontSize: size * 0.45,
      }}
      title={userId}
    >
      {userId.charAt(0).toUpperCase()}
    </span>
  );
}

function CompositionBar({
  slices,
  total,
}: {
  slices: CompositionSlice[];
  total: number;
}) {
  const attributed = slices.reduce((n, s) => n + s.chars, 0);
  const unattributed = Math.max(0, total - attributed);
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      {slices.map((s) => (
        <div
          key={s.userId}
          style={{
            width: `${(s.chars / total) * 100}%`,
            backgroundColor: colorForUser(s.userId),
          }}
          title={`${s.userId}: ${s.chars} chars`}
        />
      ))}
      {unattributed > 0 && (
        <div
          style={{ width: `${(unattributed / total) * 100}%` }}
          className="bg-gray-300 dark:bg-gray-600"
          title={`Unattributed: ${unattributed} chars`}
        />
      )}
    </div>
  );
}

function ContributorChips({
  contributions,
}: {
  contributions: Contribution[];
}) {
  if (contributions.length === 0) {
    return (
      <p className="text-xs text-gray-400 dark:text-gray-500">
        No attributed edits yet.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {contributions.map((c) => (
        <span
          key={c.userId}
          className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-300"
        >
          <Avatar userId={c.userId} size={16} />
          {c.userId}
          <span className="text-gray-400 dark:text-gray-500">{c.edits}</span>
        </span>
      ))}
    </div>
  );
}

export function AttributionPanel({
  provider,
  selectedMilestone,
  isOpen,
  onClose,
}: AttributionPanelProps) {
  const [composition, setComposition] = useState<CompositionSlice[]>([]);
  const [totalChars, setTotalChars] = useState(0);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [milestoneContributors, setMilestoneContributors] = useState<
    Contribution[] | null
  >(null);
  const [changeset, setChangeset] = useState<Contribution[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const identity = getIdentity();

  const refresh = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      const [map, timeline] = await Promise.all([
        provider.getAttributionMap(),
        provider.getActivity(),
      ]);

      if (map) {
        const byUser = new Map<string, number>();
        const totals = { total: 0 };
        walkText(provider.doc.getXmlFragment("document"), map, byUser, totals);
        setComposition(
          [...byUser.entries()]
            .map(([userId, chars]) => ({ userId, chars }))
            .sort((a, b) => b.chars - a.chars),
        );
        setTotalChars(totals.total);
      } else {
        setComposition([]);
        setTotalChars(0);
      }

      setActivity([...timeline].sort((a, b) => b.from - a.from));
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : "Failed to load attribution",
      );
    }
  }, [provider]);

  const refreshMilestone = useCallback(async () => {
    if (!provider || !selectedMilestone) {
      setMilestoneContributors(null);
      setChangeset(null);
      return;
    }
    try {
      const here = await provider.getMilestoneActivity(selectedMilestone.id);
      setMilestoneContributors(toContributions(here));

      // Compare against the milestone created immediately before this one.
      const all = (await provider.listMilestones()).sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      const idx = all.findIndex((m) => m.id === selectedMilestone.id);
      const prev = idx > 0 ? all[idx - 1] : null;
      if (prev) {
        const delta = await provider.getChangesetActivity(
          prev.id,
          selectedMilestone.id,
        );
        setChangeset(toContributions(delta));
      } else {
        setChangeset(null);
      }
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : "Failed to load milestone",
      );
    }
  }, [provider, selectedMilestone]);

  // Refresh on open, and live-update (debounced) as the document changes.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isOpen || !provider) return;
    refresh();
    refreshMilestone();

    const onUpdate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        refresh();
      }, 1200);
    };
    provider.doc.on("updateV2", onUpdate);
    return () => {
      provider.doc.off("updateV2", onUpdate);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isOpen, provider, refresh, refreshMilestone]);

  if (!isOpen) return null;

  return (
    <div className="w-80 flex-shrink-0 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center h-16 px-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <button
          onClick={onClose}
          className="p-2 mr-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          aria-label="Close authorship panel"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Authorship
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Who wrote what
          </p>
        </div>
        <button
          onClick={refresh}
          className="p-2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          aria-label="Refresh"
          title="Refresh"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>

      {/* You are */}
      <div className="mx-4 mt-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 shrink-0">
        {editingName ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("name") as string;
              setIdentity(value);
              globalThis.location.reload();
            }}
            className="flex items-center gap-2"
          >
            <input
              name="name"
              defaultValue={identity.name}
              autoFocus
              className="flex-1 min-w-0 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-800 dark:text-white"
            />
            <button
              type="submit"
              className="px-2 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded"
            >
              Switch
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <Avatar userId={identity.name} size={28} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                You are
              </p>
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                {identity.name}
              </p>
            </div>
            <button
              onClick={() => setEditingName(true)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              Switch user
            </button>
          </div>
        )}
        <p className="mt-2 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
          Open a second tab and switch the name to collaborate as another
          author.
        </p>
      </div>

      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg shrink-0">
          <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Composition */}
        <section>
          <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Document composition
          </h3>
          {totalChars === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Start typing to see authorship appear here.
            </p>
          ) : (
            <>
              <CompositionBar slices={composition} total={totalChars} />
              <div className="mt-3 space-y-1.5">
                {composition.map((s) => (
                  <div
                    key={s.userId}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Avatar userId={s.userId} size={18} />
                    <span className="flex-1 truncate text-gray-700 dark:text-gray-300">
                      {s.userId}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                      {Math.round((s.chars / totalChars) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {/* Milestone-scoped */}
        {selectedMilestone && (
          <section className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <h3 className="text-xs font-medium text-amber-800 dark:text-amber-300 uppercase tracking-wider mb-2">
              {selectedMilestone.name || "Selected version"}
            </h3>
            <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70 mb-1">
              Contributors to this version
            </p>
            <ContributorChips contributions={milestoneContributors ?? []} />
            {changeset && (
              <>
                <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70 mt-3 mb-1">
                  Changes since the previous version
                </p>
                <ContributorChips contributions={changeset} />
              </>
            )}
          </section>
        )}

        {/* Activity timeline */}
        <section>
          <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
            Recent activity
          </h3>
          {activity.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              No activity recorded yet.
            </p>
          ) : (
            <div className="space-y-2">
              {activity.slice(0, 40).map((entry, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <Avatar userId={entry.userId ?? "unknown"} size={22} />
                  <span className="flex-1 truncate text-sm text-gray-700 dark:text-gray-300">
                    {entry.userId ?? "unknown"} edited
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                    {relativeTime(entry.from)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
