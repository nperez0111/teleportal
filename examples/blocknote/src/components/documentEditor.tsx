import { useState, useEffect, Suspense } from "react";
import { Editor } from "./editor";
import { fileService } from "../services/fileService";
import { useProvider } from "../utils/providers";
import { MilestonePanel } from "./milestonePanel";
import { AttributionPanel } from "./attributionPanel";
import { PresenceAvatars } from "./presenceAvatars";
import { ConnectionToggle } from "./connectionToggle";
import { getIdentity } from "../utils/identity";
import { Milestone } from "teleportal";

interface DocumentEditorProps {
  documentId: string | null;
  isSidebarOpen?: boolean;
  toggleSidebar?: () => void;
  closeSidebar?: () => void;
}

export function DocumentEditor({ documentId, isSidebarOpen, toggleSidebar }: DocumentEditorProps) {
  const document = fileService.getDocument(documentId);
  const [, forceUpdate] = useState<number>(0);
  const { provider } = useProvider(document?.id, document?.encryptedKey, document?.wrappingKey);
  const [isMilestonePanelOpen, setIsMilestonePanelOpen] = useState(false);
  const [isAttributionPanelOpen, setIsAttributionPanelOpen] = useState(false);
  const [selectedMilestone, setSelectedMilestone] = useState<Milestone | null>(null);
  const identity = getIdentity();

  useEffect(() => {
    const unsubscribe = fileService.on("documents", () => {
      forceUpdate((prev) => prev + 1);
    });
    return () => {
      fileService.off("documents", unsubscribe);
    };
  }, []);

  // Expose the provider for console inspection during sync debugging, e.g.
  // `window.__tpProvider.doc.store.pendingStructs` (non-null means the ydoc
  // parked updates on a missing dependency).
  useEffect(() => {
    (window as unknown as { __tpProvider?: unknown }).__tpProvider = provider;
  }, [provider]);

  // Reset milestone state when document changes
  useEffect(() => {
    setSelectedMilestone(null);
    setIsMilestonePanelOpen(false);
    setIsAttributionPanelOpen(false);
  }, [documentId]);

  if (!documentId || !document) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-gray-500 dark:text-gray-400 max-w-sm">
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
          <h3 className="text-lg font-medium mb-2">No document selected</h3>
          <p className="text-sm">Select a document from the sidebar to start editing</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Document Header */}
      <div className="border-b h-auto min-h-[60px] md:h-20 border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 md:px-6 py-3 md:py-4 shrink-0">
        <div className="flex items-center gap-2 md:gap-4 flex-nowrap min-w-0">
          {/* Hamburger button for mobile */}
          {toggleSidebar && (
            <button
              onClick={toggleSidebar}
              className="md:hidden p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors shrink-0"
              aria-label="Toggle sidebar"
              type="button"
            >
              <svg
                className="w-6 h-6 text-gray-600 dark:text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isSidebarOpen ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                )}
              </svg>
            </button>
          )}
          {/* Title, icon, and date */}
          <div className="min-w-0 shrink">
            <div className="flex items-center gap-2">
              <h1 className="text-lg md:text-xl font-semibold text-gray-900 dark:text-white truncate">
                {document.name}
              </h1>
              {Boolean(document.encryptedKey) && (
                <svg
                  className="w-4 h-4 md:w-5 md:h-5 text-gray-500 dark:text-gray-400 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8V7a4 4 0 00-8 0v4"
                  />
                </svg>
              )}
            </div>
            <p className="hidden md:block text-sm text-gray-500 dark:text-gray-400">
              Created {new Date(document.createdAt).toLocaleDateString()} • Last updated{" "}
              {new Date(document.updatedAt).toLocaleDateString()}
            </p>
          </div>
          {/* Versions + Authorship buttons - pushed to the right */}
          <div className="flex items-center ml-auto shrink-0 gap-2">
            <PresenceAvatars provider={provider} />
            <div className="hidden md:block w-px h-6 bg-gray-200 dark:bg-gray-700" />
            <ConnectionToggle provider={provider} />
            <button
              onClick={() => setIsAttributionPanelOpen((v) => !v)}
              className={`px-3 py-2 text-sm font-medium border rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap ${
                isAttributionPanelOpen
                  ? "text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700"
                  : "text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
              title="See who wrote what"
            >
              <svg
                className="w-4 h-4 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a4 4 0 10-3-6.65"
                />
              </svg>
              <span className="hidden md:inline">Authorship</span>
            </button>
            <button
              onClick={() => setIsMilestonePanelOpen(true)}
              className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap"
              title="View document versions"
            >
              <svg
                className="w-4 h-4 shrink-0"
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
              <span className="hidden md:inline">Versions</span>
            </button>
          </div>
        </div>
      </div>

      {/* Editor Area with Versions Panel */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="h-full max-w-5xl mx-auto w-full px-4 md:px-6 lg:px-8 py-4 md:py-6">
            {provider && (
              <Suspense
                fallback={
                  <div className="flex items-center justify-center h-32">
                    <div className="text-gray-500 dark:text-gray-400">Loading editor...</div>
                  </div>
                }
              >
                <Editor
                  selectedMilestone={selectedMilestone}
                  provider={provider}
                  user={identity}
                  key={provider.doc.clientID}
                />
              </Suspense>
            )}
          </div>
        </div>

        {/* Authorship Panel - pushes content instead of overlaying */}
        <AttributionPanel
          provider={provider}
          selectedMilestone={selectedMilestone}
          isOpen={isAttributionPanelOpen}
          onClose={() => setIsAttributionPanelOpen(false)}
        />

        {/* Milestone Panel - pushes content instead of overlaying */}
        <MilestonePanel
          onChangeSelectedMilestone={setSelectedMilestone}
          selectedMilestone={selectedMilestone}
          provider={provider}
          isOpen={isMilestonePanelOpen}
          onClose={() => setIsMilestonePanelOpen(false)}
        />
      </div>
    </div>
  );
}
