export type KeyEntry = {
  userId: string;
  displayName: string;
  fingerprint: string;
  active: boolean;
};

export type KeySnapshot = {
  seq: number;
  generation: number;
  entries: KeyEntry[];
};

export function KeyRegistryPanel({
  current,
  history,
}: {
  current: KeySnapshot | null;
  history: KeySnapshot[];
}) {
  if (!current) return null;

  const currentActiveIds = new Set(current.entries.filter((e) => e.active).map((e) => e.userId));
  const retiredEntries: { entry: KeyEntry; seq: number }[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    for (const e of history[i].entries) {
      if (e.active && !currentActiveIds.has(e.userId) && !seen.has(e.userId)) {
        retiredEntries.push({ entry: e, seq: history[i].seq });
        seen.add(e.userId);
      }
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Key Registry
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-violet-600">
            doc key gen {current.generation}
          </span>
          <span className="text-xs font-mono text-gray-400">op #{current.seq}</span>
        </div>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div>
          <h4 className="text-[10px] font-semibold text-emerald-500 uppercase tracking-wider mb-1.5">
            Active Keys
          </h4>
          <div className="flex flex-wrap gap-2">
            {current.entries
              .filter((e) => e.active)
              .map((entry) => (
                <KeyBadge key={entry.userId} entry={entry} />
              ))}
            {current.entries.filter((e) => e.active).length === 0 && (
              <span className="text-xs text-gray-400 italic">No active keys</span>
            )}
          </div>
        </div>
        {retiredEntries.length > 0 && (
          <div>
            <h4 className="text-[10px] font-semibold text-red-400 uppercase tracking-wider mb-1.5">
              Retired Keys
            </h4>
            <div className="space-y-1">
              {retiredEntries.map(({ entry, seq }) => (
                <div key={entry.userId} className="flex items-center gap-2 text-xs">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-300" />
                  <span className="text-gray-500 line-through">{entry.displayName}</span>
                  <code className="text-[10px] text-gray-400 bg-gray-50 px-1 rounded font-mono">
                    {entry.fingerprint}
                  </code>
                  <span className="text-red-400">revoked at op #{seq}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KeyBadge({ entry }: { entry: KeyEntry }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-1">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
      <span className="text-xs font-medium text-gray-700">{entry.displayName}</span>
      <code className="text-[10px] text-violet-600 bg-violet-50 px-1 rounded font-mono">
        {entry.fingerprint}
      </code>
    </div>
  );
}
