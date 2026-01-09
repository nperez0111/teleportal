import { useState, useEffect } from "react";
import type { Provider } from "teleportal/providers";
import type { Milestone } from "teleportal";

interface MilestonePanelProps {
  onChangeSelectedMilestone: (milestone: Milestone | null) => void;
  provider: Provider | null;
  isOpen: boolean;
  onClose: () => void;
}

export function MilestonePanel({
  onChangeSelectedMilestone,
  provider,
  isOpen,
  onClose,
}: MilestonePanelProps) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newMilestoneName, setNewMilestoneName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [loadingSnapshot, setLoadingSnapshot] = useState<string | null>(null);
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(
    null,
  );
  const [editingName, setEditingName] = useState("");

  // Load milestones when panel opens
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
      setMilestones(list);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load milestones",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMilestone = async () => {
    if (!provider) return;

    setCreating(true);
    setError(null);
    try {
      const name = newMilestoneName.trim() || undefined;
      const milestone = await provider.createMilestone(name);
      setMilestones((prev) =>
        [milestone, ...prev].sort((a, b) => b.createdAt - a.createdAt),
      );
      setNewMilestoneName("");
      setShowCreateForm(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create milestone",
      );
    } finally {
      setCreating(false);
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

    try {
      const updated = await provider.updateMilestoneName(
        milestone.id,
        newName.trim(),
      );
      setMilestones((prev) =>
        prev.map((m) => (m.id === milestone.id ? updated : m)),
      );
      setEditingMilestoneId(null);
      setEditingName("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update milestone name",
      );
    }
  };

  const handleStartEdit = (milestone: Milestone) => {
    setEditingMilestoneId(milestone.id);
    setEditingName(milestone.name || "");
    setError(null);
  };

  const handleCancelEdit = () => {
    setEditingMilestoneId(null);
    setEditingName("");
  };

  const handleSaveEdit = async (milestone: Milestone) => {
    if (editingName.trim() === milestone.name) {
      handleCancelEdit();
      return;
    }
    await handleUpdateName(milestone, editingName);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Document Versions
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            aria-label="Close"
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
        </div>

        {/* Error message */}
        {error && (
          <div className="mx-4 mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        {/* Create milestone form */}
        {showCreateForm && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
            <div className="flex gap-2">
              <input
                type="text"
                value={newMilestoneName}
                onChange={(e) => setNewMilestoneName(e.target.value)}
                placeholder="Version name (optional)"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900 dark:text-white"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateMilestone();
                  if (e.key === "Escape") {
                    setShowCreateForm(false);
                    setNewMilestoneName("");
                  }
                }}
                autoFocus
              />
              <button
                onClick={handleCreateMilestone}
                disabled={creating}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
              >
                {creating ? "Creating..." : "Create"}
              </button>
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setNewMilestoneName("");
                }}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-gray-500 dark:text-gray-400">
                Loading milestones...
              </div>
            </div>
          ) : milestones.length === 0 ? (
            <div className="text-center py-12">
              <svg
                className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="text-gray-500 dark:text-gray-400 mb-4">
                No versions yet
              </p>
              <p className="text-sm text-gray-400 dark:text-gray-500">
                Create your first snapshot to save the current document state
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {milestones.map((milestone) => (
                <div
                  key={milestone.id}
                  className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {editingMilestoneId === milestone.id ? (
                        <div className="flex items-center gap-2 mb-1">
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            className="flex-1 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900 dark:text-white"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleSaveEdit(milestone);
                              }
                              if (e.key === "Escape") {
                                handleCancelEdit();
                              }
                            }}
                            autoFocus
                          />
                          <button
                            onClick={() => handleSaveEdit(milestone)}
                            className="p-1.5 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
                            aria-label="Save"
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
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                            aria-label="Cancel"
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
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {milestone.name || "Unnamed Version"}
                          </h3>
                          {milestone.loaded && (
                            <span className="text-xs px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded">
                              Loaded
                            </span>
                          )}
                          <button
                            onClick={() => handleStartEdit(milestone)}
                            className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
                            aria-label="Edit name"
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
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </button>
                        </div>
                      )}
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Created {new Date(milestone.createdAt).toLocaleString()}
                      </p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                        ID: {milestone.id.slice(0, 8)}...
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleViewSnapshot(milestone)}
                        disabled={
                          loadingSnapshot === milestone.id ||
                          editingMilestoneId === milestone.id
                        }
                        className="px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {loadingSnapshot === milestone.id
                          ? "Loading..."
                          : "View Snapshot"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <button
            onClick={loadMilestones}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowCreateForm(true)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2"
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
            Create Version
          </button>
        </div>
      </div>
    </div>
  );
}
