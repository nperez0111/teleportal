import { useCallback, useEffect, useRef, useState } from "react";
import { setup, revokeUser, restoreUser, rotateKeys, fetchMeta } from "../api";
import { AccessPanel, type UserInfo } from "./access-panel";
import { EventLog, type LogEntry } from "./event-log";
import { KeyRegistryPanel, type KeySnapshot } from "./key-registry-panel";
import { UserSession } from "./user-session";

const DEFAULT_USER_IDS = ["alice", "bob", "eve"];
const DISPLAY_NAMES: Record<string, string> = { alice: "Alice", bob: "Bob", eve: "Eve" };

type UserState = {
  userId: string;
  displayName: string;
  role: string;
  status: "connecting" | "connected" | "revoked" | "reminted";
  token: string;
  wrappingKey: string;
  providerKey: number;
};

export function Shell() {
  const [users, setUsers] = useState<UserState[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [room, setRoom] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keySnapshot, setKeySnapshot] = useState<KeySnapshot | null>(null);
  const [keyHistory, setKeyHistory] = useState<KeySnapshot[]>([]);
  const [lastSeen, setLastSeen] = useState<Record<string, { content: string; timestamp: number }>>(
    {},
  );
  const [rotatedWhileRevoked, setRotatedWhileRevoked] = useState<Set<string>>(new Set());
  const fingerprintsRef = useRef<Record<string, string>>({});
  const seqRef = useRef(0);
  const logIdRef = useRef(0);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    setLog((prev) => [
      ...prev,
      {
        id: logIdRef.current++,
        timestamp: Date.now(),
        message,
        type,
      },
    ]);
  }, []);

  const refreshMeta = useCallback(async () => {
    try {
      const meta = await fetchMeta();
      const snap: KeySnapshot = {
        seq: seqRef.current++,
        generation: meta.generation,
        entries: DEFAULT_USER_IDS.map((id) => ({
          userId: id,
          displayName: DISPLAY_NAMES[id] ?? id,
          fingerprint: fingerprintsRef.current[id] ?? "—",
          active: meta.userIds.includes(id),
        })),
      };
      setKeySnapshot((prev) => {
        if (prev) {
          const prevActive = prev.entries
            .filter((e) => e.active)
            .map((e) => e.userId)
            .sort()
            .join(",");
          const snapActive = snap.entries
            .filter((e) => e.active)
            .map((e) => e.userId)
            .sort()
            .join(",");
          if (prevActive !== snapActive || prev.generation !== snap.generation) {
            setKeyHistory((h) => [...h, prev]);
          }
        }
        return snap;
      });
    } catch {
      // meta fetch is non-critical
    }
  }, []);

  useEffect(() => {
    addLog("Initializing access control demo...", "info");

    setup()
      .then(async ({ documentId: docId, room: r, users: userMap }) => {
        setDocumentId(docId);
        setRoom(r);

        for (const [id, u] of Object.entries(userMap)) {
          fingerprintsRef.current[id] = u.wrappingKey.slice(0, 12);
        }

        const userStates: UserState[] = DEFAULT_USER_IDS.filter((id) => userMap[id]).map((id) => ({
          userId: id,
          displayName: userMap[id].displayName,
          role: userMap[id].role,
          status: "connecting" as const,
          token: userMap[id].token,
          wrappingKey: userMap[id].wrappingKey,
          providerKey: 0,
        }));

        setUsers(userStates);

        addLog("Document key minted for Alice", "crypto");
        addLog("Key granted to Bob (wrapped with user-specific key)", "crypto");
        addLog("Key granted to Eve (wrapped with user-specific key)", "crypto");
        addLog("All users initialized — connecting...", "info");

        await refreshMeta();
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Setup failed");
        addLog(`Setup failed: ${err}`, "error");
      });
  }, []);

  const handleStatusChange = useCallback((userId: string, status: "connecting" | "connected") => {
    setUsers((prev) => prev.map((u) => (u.userId === userId ? { ...u, status } : u)));
  }, []);

  const handleContentSnapshot = useCallback((userId: string, content: string) => {
    setLastSeen((prev) => ({
      ...prev,
      [userId]: { content, timestamp: Date.now() },
    }));
  }, []);

  const handleRevoke = useCallback(
    async (userId: string) => {
      const user = users.find((u) => u.userId === userId);
      if (!user) return;

      setBusy(true);
      addLog(`Revoking ${user.displayName}'s encryption key...`, "warning");

      setUsers((prev) =>
        prev.map((u) => (u.userId === userId ? { ...u, status: "revoked" as const } : u)),
      );

      try {
        const result = await revokeUser(userId);
        addLog(
          `${user.displayName}'s encryption key entry removed (generation ${result.generation})`,
          "crypto",
        );
        addLog(`${user.displayName}'s view frozen — future edits will not be visible`, "error");
        await refreshMeta();
      } catch (err) {
        addLog(`Revocation failed: ${err}`, "error");
        setUsers((prev) =>
          prev.map((u) => (u.userId === userId ? { ...u, status: "connected" as const } : u)),
        );
      } finally {
        setBusy(false);
      }
    },
    [users, addLog],
  );

  const handleRestore = useCallback(
    async (userId: string) => {
      const user = users.find((u) => u.userId === userId);
      if (!user) return;

      const wasRotated = rotatedWhileRevoked.has(userId);
      setBusy(true);
      addLog(
        wasRotated
          ? `Re-minting encryption key for ${user.displayName} (new document key)...`
          : `Granting encryption key to ${user.displayName}...`,
        "crypto",
      );

      try {
        const result = await restoreUser(userId, user.role);
        if (wasRotated) {
          setUsers((prev) =>
            prev.map((u) => (u.userId === userId ? { ...u, status: "reminted" as const } : u)),
          );
        } else {
          setUsers((prev) =>
            prev.map((u) =>
              u.userId === userId
                ? {
                    ...u,
                    status: "connecting" as const,
                    token: result.token,
                    wrappingKey: result.wrappingKey,
                    providerKey: u.providerKey + 1,
                  }
                : u,
            ),
          );
          setLastSeen((prev) => {
            const next = { ...prev };
            delete next[userId];
            return next;
          });
        }
        setRotatedWhileRevoked((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
        addLog(
          wasRotated
            ? `${user.displayName} issued new key (gen ${keySnapshot?.generation ?? "?"}) — historical content encrypted with old key will not be accessible`
            : `${user.displayName} granted key — reconnecting...`,
          wasRotated ? "warning" : "success",
        );
        await refreshMeta();
      } catch (err) {
        addLog(`Restore failed: ${err}`, "error");
      } finally {
        setBusy(false);
      }
    },
    [users, addLog, rotatedWhileRevoked, keySnapshot],
  );

  const handleRotate = useCallback(async () => {
    const revokedUsers = users.filter((u) => u.status === "revoked");
    const revokedIds = revokedUsers.map((u) => u.userId);
    const activeNames = users
      .filter((u) => u.status !== "revoked")
      .map((u) => u.displayName)
      .join(", ");

    setBusy(true);
    addLog("Rotating document encryption key...", "crypto");

    try {
      const result = await rotateKeys(revokedIds);
      addLog(`Document key rotated (generation ${result.generation})`, "crypto");
      addLog(`Active users (${activeNames}) re-keyed automatically`, "success");
      for (const u of revokedUsers) {
        addLog(`${u.displayName} permanently excluded — new content uses a different key`, "error");
      }
      setRotatedWhileRevoked((prev) => {
        const next = new Set(prev);
        revokedIds.forEach((id) => next.add(id));
        return next;
      });
      await refreshMeta();
    } catch (err) {
      addLog(`Rotation failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  }, [users, addLog]);

  const hasRevokedUsers = users.some((u) => u.status === "revoked");

  const userInfos: UserInfo[] = users.map((u) => ({
    userId: u.userId,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    keyRotatedSinceRevoke: rotatedWhileRevoked.has(u.userId),
  }));

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 font-medium">Error: {error}</p>
          <p className="text-sm text-gray-500 mt-1">Check the server console for details</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-6 py-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Access Control</h1>
        <p className="text-sm text-gray-500">
          Per-user end-to-end encryption with live grant, revoke, and key rotation. Each panel is an
          independent session with its own JWT token and encryption key.
        </p>
      </div>

      <AccessPanel
        users={userInfos}
        busy={busy}
        onRevoke={handleRevoke}
        onRestore={handleRestore}
        onRotate={handleRotate}
        hasRevokedUsers={hasRevokedUsers}
      />

      <KeyRegistryPanel current={keySnapshot} history={keyHistory} />

      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          User Sessions
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {users.map((user) => (
            <UserSession
              key={user.userId}
              userId={user.userId}
              displayName={user.displayName}
              role={user.role}
              status={user.status}
              token={user.token}
              wrappingKey={user.wrappingKey}
              providerKey={user.providerKey}
              documentId={documentId}
              room={room}
              lastSeenContent={lastSeen[user.userId]?.content ?? null}
              lastSeenTimestamp={lastSeen[user.userId]?.timestamp ?? null}
              keyRotatedSinceRevoke={rotatedWhileRevoked.has(user.userId)}
              onStatusChange={handleStatusChange}
              onContentSnapshot={handleContentSnapshot}
              onEvent={addLog}
            />
          ))}
        </div>
      </div>

      <EventLog entries={log} />
    </div>
  );
}
