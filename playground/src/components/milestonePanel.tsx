import { useState, useEffect } from "react";
import type { Provider } from "teleportal/providers";
import type { Milestone } from "teleportal";

interface MilestonePanelProps {
  onChangeSelectedMilestone: (milestone: Milestone | null) => void;
  selectedMilestone: Milestone | null;
  provider: Provider | null;
  isOpen: boolean;
  onClose: () => void;
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  placeholder: string;
  initialValue?: string;
  confirmLabel: string;
  loading: boolean;
  onConfirm: (value: string) => Promise<void>;
}

function Modal({
  isOpen,
  onClose,
  title,
  description,
  placeholder,
  initialValue = "",
  confirmLabel,
  loading,
  onConfirm,
}: ModalProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (isOpen) {
      setValue(initialValue);
    }
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    await onConfirm(value);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 dark:bg-black/70">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 border-b border-gray-200 dark:border-gray-800">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
            {title}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {description}
          </p>
        </div>
        <div className="p-6">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="w-full px-4 py-3 text-base border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") onClose();
            }}
            autoFocus
          />
        </div>
        <div className="p-6 pt-0 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 dark:hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
          >
            {loading ? "Loading..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MilestonePanel({
  onChangeSelectedMilestone,
  selectedMilestone,
  provider,
  isOpen,
  onClose,
}: MilestonePanelProps) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState<string | null>(null);
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(
    null,
  );

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);
  const [editLoading, setEditLoading] = useState(false);

  useEffect(() => {
    if (isOpen && provider) {
      loadMilestones();
    }
  }, [isOpen, provider]);

  const loadMilestones = async () => {
    if (!provider) return;

    setLoading(true);
    setError(null);
    try {
      const list = await provider.listMilestones();
      setMilestones(list.sort((a, b) => b.createdAt - a.createdAt));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load milestones",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMilestone = async (name: string) => {
    if (!provider) return;

    setCreateLoading(true);
    setError(null);
    try {
      const milestone = await provider.createMilestone(
        name.trim() || undefined,
      );
      setMilestones((prev) =>
        [milestone, ...prev].sort((a, b) => b.createdAt - a.createdAt),
      );
      setShowCreateModal(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create milestone",
      );
    } finally {
      setCreateLoading(false);
    }
  };

  const handleViewSnapshot = async (milestone: Milestone) => {
    setLoadingSnapshot(milestone.id);
    setError(null);
    try {
      await milestone.fetchSnapshot();
      onChangeSelectedMilestone(milestone);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load snapshot");
    } finally {
      setLoadingSnapshot(null);
    }
  };

  const handleUpdateName = async (milestone: Milestone, newName: string) => {
    if (!provider || !newName.trim()) return;

    setEditLoading(true);
    try {
      const updated = await provider.updateMilestoneName(
        milestone.id,
        newName.trim(),
      );
      setMilestones((prev) =>
        prev.map((m) => (m.id === milestone.id ? updated : m)),
      );
      setShowEditModal(false);
      setEditingMilestone(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update milestone name",
      );
    } finally {
      setEditLoading(false);
    }
  };

  const handleStartEdit = (milestone: Milestone) => {
    setEditingMilestone(milestone);
    setShowEditModal(true);
    setError(null);
  };

  const handleBackToCurrent = () => {
    onChangeSelectedMilestone(null);
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return `Today at ${date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }

    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="w-80 flex-shrink-0 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 flex flex-col h-full overflow-hidden">
        <div className="flex items-center h-16 px-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="flex items-center gap-3 flex-1">
            <button
              onClick={onClose}
              className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
              aria-label="Close versions panel"
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
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Versions
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Document history
              </p>
            </div>
          </div>
        </div>

        {selectedMilestone && (
          <div className="mx-4 mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg shrink-0">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  Viewing snapshot
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5 truncate">
                  {selectedMilestone.name ||
                    `Version from ${formatDate(selectedMilestone.createdAt)}`}
                </p>
                <button
                  onClick={handleBackToCurrent}
                  className="mt-2 px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 dark:hover:bg-amber-700 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 17l-5-5m0 0l5-5m-5 5h12"
                    />
                  </svg>
                  Back to Current
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg shrink-0">
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-2">
            <div
              className={`p-3 rounded-lg border transition-all cursor-pointer ${
                selectedMilestone === null
                  ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
                  : "bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
              onClick={() =>
                selectedMilestone !== null && handleBackToCurrent()
              }
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    selectedMilestone === null
                      ? "bg-blue-500 text-white"
                      : "bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                  }`}
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
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    Current Version
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Live editor content
                  </p>
                </div>
                {selectedMilestone === null && (
                  <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                    Viewing
                  </span>
                )}
              </div>
            </div>

            <div className="pt-2 pb-1">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider px-2">
                Snapshots
              </p>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                  <svg
                    className="w-5 h-5 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Loading...
                </div>
              </div>
            ) : milestones.length === 0 ? (
              <div className="text-center py-8">
                <svg
                  className="w-12 h-12 mx-auto mb-3 text-gray-300 dark:text-gray-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                  No snapshots yet
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  Create a snapshot to save the current state
                </p>
              </div>
            ) : (
              milestones.map((milestone) => (
                <div
                  key={milestone.id}
                  className={`p-3 rounded-lg border transition-all ${
                    selectedMilestone?.id === milestone.id
                      ? "bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700 ring-2 ring-blue-200 dark:ring-blue-800"
                      : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                  onClick={() => handleViewSnapshot(milestone)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {milestone.name ||
                            `Version ${milestones.indexOf(milestone) + 1}`}
                        </h3>
                        {selectedMilestone?.id === milestone.id && (
                          <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                            Viewing
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {formatDate(milestone.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStartEdit(milestone);
                      }}
                      disabled={loadingSnapshot === milestone.id}
                      className="p-2 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                      aria-label="Rename"
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
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <button
            onClick={() => setShowCreateModal(true)}
            className="w-full px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-700 rounded-lg transition-colors flex items-center justify-center gap-2"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            Create Snapshot
          </button>
        </div>
      </div>

      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create Snapshot"
        description="Save the current document state"
        placeholder="Version name (optional)"
        confirmLabel="Create"
        loading={createLoading}
        onConfirm={handleCreateMilestone}
      />

      <Modal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setEditingMilestone(null);
        }}
        title="Rename Version"
        description="Give this snapshot a new name"
        placeholder="Version name"
        initialValue={editingMilestone?.name || ""}
        confirmLabel="Save"
        loading={editLoading}
        onConfirm={async (name) => {
          if (editingMilestone) {
            await handleUpdateName(editingMilestone, name);
          }
        }}
      />
    </>
  );
}
