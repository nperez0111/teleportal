export type UserInfo = {
  userId: string;
  displayName: string;
  role: string;
  status: "connecting" | "connected" | "revoked" | "reminted";
  keyRotatedSinceRevoke: boolean;
};

const roleBadgeStyles: Record<string, string> = {
  admin: "bg-violet-100 text-violet-700",
  editor: "bg-blue-100 text-blue-700",
  viewer: "bg-gray-100 text-gray-600",
};

const statusDot: Record<string, string> = {
  connecting: "bg-amber-400",
  connected: "bg-emerald-500",
  revoked: "bg-red-500",
  reminted: "bg-amber-500",
};

export function AccessPanel({
  users,
  busy,
  onRevoke,
  onRestore,
  onRotate,
  hasRevokedUsers,
}: {
  users: UserInfo[];
  busy: boolean;
  onRevoke: (userId: string) => void;
  onRestore: (userId: string) => void;
  onRotate: () => void;
  hasRevokedUsers: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Access Control
        </h3>
        <div className="flex items-center gap-3">
          {hasRevokedUsers && (
            <button
              disabled={busy}
              onClick={onRotate}
              className="px-2.5 py-1 text-xs font-medium text-violet-600 bg-violet-50 hover:bg-violet-100 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Rotate Keys
            </button>
          )}
          <span className="text-xs text-gray-400">Per-user E2E encryption keys</span>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">User</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Role</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Status</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.userId} className="border-b border-gray-50">
              <td className="px-4 py-2 font-medium text-gray-900">{user.displayName}</td>
              <td className="px-4 py-2">
                <span
                  className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${roleBadgeStyles[user.role] ?? roleBadgeStyles.viewer}`}
                >
                  {user.role}
                </span>
              </td>
              <td className="px-4 py-2">
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block w-2 h-2 rounded-full ${statusDot[user.status]}`} />
                  <span className="text-gray-600 capitalize">
                    {user.keyRotatedSinceRevoke ? "excluded" : user.status}
                  </span>
                </span>
              </td>
              <td className="px-4 py-2 text-right">
                {user.role !== "admin" &&
                  user.status !== "revoked" &&
                  user.status !== "reminted" && (
                    <button
                      disabled={busy}
                      onClick={() => onRevoke(user.userId)}
                      className="px-2.5 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Revoke
                    </button>
                  )}
                {user.status === "revoked" && (
                  <button
                    disabled={busy}
                    onClick={() => onRestore(user.userId)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      user.keyRotatedSinceRevoke
                        ? "text-amber-600 bg-amber-50 hover:bg-amber-100"
                        : "text-emerald-600 bg-emerald-50 hover:bg-emerald-100"
                    }`}
                  >
                    {user.keyRotatedSinceRevoke ? "Re-mint Key" : "Restore"}
                  </button>
                )}
                {user.status === "reminted" && (
                  <span className="text-[10px] text-amber-500 italic">re-minted</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
