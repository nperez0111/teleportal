import type { MovableTree } from "teleportal/movable-tree";
import type { FileMeta } from "./shell";

interface TabBarProps {
  tabs: string[];
  activeTab: string | null;
  tree: MovableTree<FileMeta>;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

/** Build the full path string for a node (e.g., "Documents / Welcome.md"). */
function getTabTooltip(tree: MovableTree<FileMeta>, nodeId: string): string {
  const node = tree.getNode(nodeId);
  if (!node) return "Unknown";
  const segments = node.path
    .filter((n) => n.id !== "__root__" && n.id !== "__trash__")
    .map((n) => n.meta?.name ?? "Unknown");
  return segments.join(" / ");
}

export function TabBar({ tabs, activeTab, tree, onSelectTab, onCloseTab }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex border-b border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-[#252526] overflow-x-auto flex-shrink-0">
      {tabs.map((nodeId) => {
        const node = tree.getNode(nodeId);
        const isActive = nodeId === activeTab;
        const tooltip = getTabTooltip(tree, nodeId);
        return (
          <button
            key={nodeId}
            onClick={() => onSelectTab(nodeId)}
            title={tooltip}
            className={`
              flex items-center gap-1.5 px-3 h-[35px] text-[13px] border-r border-gray-200 dark:border-gray-700 flex-shrink-0 group
              ${
                isActive
                  ? "bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-white border-t-2 border-t-blue-500 -mt-px"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-[#2a2a2a]"
              }
            `}
          >
            <svg
              className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
            <span className="truncate max-w-[120px]">{node?.meta?.name ?? "Unknown"}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(nodeId);
              }}
              className={`
                w-5 h-5 flex items-center justify-center rounded
                ${isActive ? "hover:bg-gray-200 dark:hover:bg-gray-700" : "opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-700"}
                text-gray-400 hover:text-gray-600 dark:hover:text-gray-300
              `}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </span>
          </button>
        );
      })}
    </div>
  );
}
