import { useState, type MouseEvent } from "react";
import type { MovableTree, TreeNode } from "teleportal/movable-tree";
import type { FileMeta } from "./shell";

interface FileTreeProps {
  tree: MovableTree<FileMeta>;
  activeFileId: string | null;
  activeFolder: TreeNode<FileMeta>;
  onOpenFile: (id: string) => void;
  onCreateFile: (parent: TreeNode<FileMeta>, name: string) => void;
  onCreateFolder: (parent: TreeNode<FileMeta>, name: string) => void;
}

let draggedNodeId: string | null = null;

function sortChildren(node: TreeNode<FileMeta>): TreeNode<FileMeta>[] {
  return [...node.children].sort((a, b) => {
    const af = a.meta?.type === "folder" ? 0 : 1;
    const bf = b.meta?.type === "folder" ? 0 : 1;
    if (af !== bf) return af - bf;
    return (a.meta?.name ?? "").localeCompare(b.meta?.name ?? "");
  });
}

export function FileTree({
  tree,
  activeFileId,
  activeFolder,
  onOpenFile,
  onCreateFile,
  onCreateFolder,
}: FileTreeProps) {
  const [newItem, setNewItem] = useState<{
    parentId: string;
    type: "file" | "folder";
  } | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);

  const startNewItem = (parent: TreeNode<FileMeta>, type: "file" | "folder") => {
    setNewItem({ parentId: parent.id, type });
  };

  const confirmNewItem = (name: string) => {
    if (!newItem || !name.trim()) {
      setNewItem(null);
      return;
    }
    const parent = tree.getNode(newItem.parentId) ?? tree.root;
    if (newItem.type === "file") onCreateFile(parent, name.trim());
    else onCreateFolder(parent, name.trim());
    setNewItem(null);
  };

  const trashChildren = sortChildren(tree.trash);

  return (
    <div className="w-60 bg-gray-50 dark:bg-[#1e1e1e] border-r border-gray-200 dark:border-gray-800 flex flex-col h-full select-none text-[13px]">
      {/* Header */}
      <div className="px-3 h-9 flex items-center justify-between border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Explorer
        </span>
        <div className="flex gap-0.5">
          <HeaderButton title="New File" onClick={() => startNewItem(activeFolder, "file")}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </HeaderButton>
          <HeaderButton title="New Folder" onClick={() => startNewItem(activeFolder, "folder")}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 13h6m-3-3v6m-2 5H5a2 2 0 01-2-2V8a2 2 0 012-2h4l2-2h6a2 2 0 012 2v12a2 2 0 01-2 2h-4"
            />
          </HeaderButton>
        </div>
      </div>

      {/* Tree */}
      <div
        className={`flex-1 overflow-y-auto py-0.5 ${rootDragOver ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}`}
        onDragOver={(e) => {
          if (!draggedNodeId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setRootDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setRootDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setRootDragOver(false);
          if (!draggedNodeId) return;
          const node = tree.getNode(draggedNodeId);
          if (node && node.parent?.id !== "__root__") node.moveTo(tree.root);
        }}
      >
        {sortChildren(tree.root).map((node) => (
          <TreeRow
            key={node.id}
            node={node}
            tree={tree}
            depth={0}
            activeFileId={activeFileId}
            newItem={newItem}
            onOpenFile={onOpenFile}
            onStartNewItem={startNewItem}
            onConfirmNewItem={confirmNewItem}
            onCancelNewItem={() => setNewItem(null)}
          />
        ))}
        {newItem?.parentId === "__root__" && (
          <NewItemInput
            type={newItem.type}
            depth={0}
            onConfirm={confirmNewItem}
            onCancel={() => setNewItem(null)}
          />
        )}
        {sortChildren(tree.root).length === 0 && !newItem && (
          <div className="px-4 py-8 text-center text-gray-400 dark:text-gray-600 text-xs">
            <p className="mb-2">No files yet</p>
            <button
              onClick={() => startNewItem(tree.root, "file")}
              className="text-blue-500 hover:text-blue-600 underline"
            >
              Create a file
            </button>
          </div>
        )}
      </div>

      {/* Trash */}
      {trashChildren.length > 0 && <TrashPanel tree={tree} items={trashChildren} />}
    </div>
  );
}

function TreeRow({
  node,
  tree,
  depth,
  activeFileId,
  newItem,
  onOpenFile,
  onStartNewItem,
  onConfirmNewItem,
  onCancelNewItem,
}: {
  node: TreeNode<FileMeta>;
  tree: MovableTree<FileMeta>;
  depth: number;
  activeFileId: string | null;
  newItem: { parentId: string; type: "file" | "folder" } | null;
  onOpenFile: (id: string) => void;
  onStartNewItem: (parent: TreeNode<FileMeta>, type: "file" | "folder") => void;
  onConfirmNewItem: (name: string) => void;
  onCancelNewItem: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

  const isFolder = node.meta?.type === "folder";
  const isActive = node.id === activeFileId;
  const children = isFolder ? sortChildren(node) : [];

  const startRename = () => {
    setEditing(true);
    setEditName(node.meta?.name ?? "");
  };

  const confirmRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== node.meta?.name) {
      node.setMeta({ ...node.meta!, name: trimmed });
    }
    setEditing(false);
  };

  return (
    <>
      <div
        draggable={!editing}
        onDragStart={(e) => {
          draggedNodeId = node.id;
          e.dataTransfer.setData("text/plain", node.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          draggedNodeId = null;
        }}
        onDragOver={(e) => {
          if (!isFolder || !draggedNodeId || draggedNodeId === node.id) return;
          const dragged = tree.getNode(draggedNodeId);
          if (dragged?.isAncestorOf(node)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          if (!draggedNodeId || draggedNodeId === node.id) return;
          const dragged = tree.getNode(draggedNodeId);
          if (!dragged || dragged.isAncestorOf(node)) return;
          dragged.moveTo(node);
        }}
        onClick={() => {
          if (editing) return;
          if (!isFolder) onOpenFile(node.id);
        }}
        onDoubleClick={() => startRename()}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        className={`
          flex items-center gap-1 h-[22px] pr-2 cursor-pointer group
          ${isActive ? "bg-blue-100/80 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200" : "text-gray-700 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-800/60"}
          ${dragOver ? "bg-blue-100 dark:bg-blue-900/40 outline outline-1 outline-blue-400 -outline-offset-1" : ""}
        `}
      >
        {isFolder ? (
          <span className="w-4 h-4 flex items-center justify-center text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
            {"▾"}
          </span>
        ) : (
          <span className="w-4 h-4 flex-shrink-0" />
        )}

        <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          {isFolder ? (
            <svg
              className="w-4 h-4 text-yellow-600 dark:text-yellow-500"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1H8a3 3 0 00-3 3v1.5a1.5 1.5 0 01-3 0V6z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500"
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
          )}
        </span>

        {editing ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={confirmRename}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="flex-1 min-w-0 px-1 text-[13px] bg-white dark:bg-gray-800 border border-blue-400 rounded-sm outline-none"
          />
        ) : (
          <span className="truncate flex-1">{node.meta?.name}</span>
        )}

        {!editing && (
          <div className="hidden group-hover:flex items-center flex-shrink-0">
            {isFolder && (
              <>
                <ActionBtn
                  title="New File"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartNewItem(node, "file");
                  }}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </ActionBtn>
                <ActionBtn
                  title="New Folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartNewItem(node, "folder");
                  }}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 13h6m-2-5H5a2 2 0 00-2 2v6a2 2 0 002 2h14a2 2 0 002-2v-4"
                  />
                </ActionBtn>
              </>
            )}
            <ActionBtn
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                startRename();
              }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </ActionBtn>
            <ActionBtn
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                node.delete();
              }}
              className="hover:!text-red-500"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </ActionBtn>
          </div>
        )}
      </div>

      {isFolder && (
        <>
          {children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              tree={tree}
              depth={depth + 1}
              activeFileId={activeFileId}
              newItem={newItem}
              onOpenFile={onOpenFile}
              onStartNewItem={onStartNewItem}
              onConfirmNewItem={onConfirmNewItem}
              onCancelNewItem={onCancelNewItem}
            />
          ))}
          {newItem?.parentId === node.id && (
            <NewItemInput
              type={newItem.type}
              depth={depth + 1}
              onConfirm={onConfirmNewItem}
              onCancel={onCancelNewItem}
            />
          )}
        </>
      )}
    </>
  );
}

function NewItemInput({
  type,
  depth,
  onConfirm,
  onCancel,
}: {
  type: "file" | "folder";
  depth: number;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");

  return (
    <div
      className="flex items-center gap-1 h-[22px] pr-2"
      style={{ paddingLeft: `${depth * 16 + 8 + 20}px` }}
    >
      <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
        {type === "folder" ? (
          <svg
            className="w-4 h-4 text-yellow-600 dark:text-yellow-500"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
        ) : (
          <svg
            className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500"
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
        )}
      </span>
      <input
        type="text"
        placeholder={type === "folder" ? "Folder name" : "File name"}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm(name);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (name.trim()) onConfirm(name);
          else onCancel();
        }}
        autoFocus
        className="flex-1 min-w-0 px-1 text-[13px] bg-white dark:bg-gray-800 border border-blue-400 rounded-sm outline-none text-gray-800 dark:text-gray-200"
      />
    </div>
  );
}

function TrashPanel({ tree, items }: { tree: MovableTree<FileMeta>; items: TreeNode<FileMeta>[] }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-t border-gray-200 dark:border-gray-800 flex-shrink-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 h-7 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-800/60"
      >
        <span className="text-[10px]">{isOpen ? "▾" : "▸"}</span>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
        Trash ({items.length})
      </button>
      {isOpen && (
        <div className="pb-1">
          {items.map((node) => (
            <div
              key={node.id}
              className="flex items-center gap-1 h-[22px] px-3 group text-gray-500 dark:text-gray-500"
            >
              <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center opacity-50">
                {node.meta?.type === "folder" ? (
                  <svg
                    className="w-4 h-4 text-yellow-600 dark:text-yellow-500"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                  </svg>
                ) : (
                  <svg
                    className="w-3.5 h-3.5"
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
                )}
              </span>
              <span className="truncate flex-1 line-through">{node.meta?.name}</span>
              <button
                onClick={() => node.restore()}
                className="hidden group-hover:block text-[11px] text-blue-500 hover:text-blue-600 flex-shrink-0"
                title="Restore to root"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HeaderButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-6 h-6 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {children}
      </svg>
    </button>
  );
}

function ActionBtn({
  title,
  onClick,
  className = "",
  children,
}: {
  title: string;
  onClick: (e: MouseEvent) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-5 h-5 flex items-center justify-center rounded text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 ${className}`}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {children}
      </svg>
    </button>
  );
}
