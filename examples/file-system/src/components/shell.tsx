import * as random from "lib0/random";
import { useEffect, useState, useMemo, useCallback, useSyncExternalStore, useRef } from "react";
import {
  DirectConnection,
  httpTransport,
  Provider,
  websocketTransport,
} from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { MovableTree } from "teleportal/movable-tree";
import type { TreeNode } from "teleportal/movable-tree";

import { FileTree } from "./file-tree";
import { TabBar } from "./tab-bar";
import { FileEditor } from "./editor";

export type FileMeta = { name: string; type: "file" | "folder" };

const usercolors = ["#30bced", "#6eeb83", "#ffbc42", "#ee6352", "#9ac2c9", "#8acb88", "#1be7ff"];

const userName = "User " + Math.floor(Math.random() * 100);
const userColor = usercolors[random.uint32() % usercolors.length]!;

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600,
  issuer: "file-system-example",
});

async function mintToken() {
  return tokenManager.createToken(userName, "docs", new DocumentAccessBuilder().admin("*").build());
}

export default function Shell() {
  const [session, setSession] = useState<{
    provider: Provider;
    connection: DirectConnection;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const t = await mintToken();
        const baseUrl = new URL("./", window.location.href).href;
        // One connection multiplexes every document over a single WebSocket:
        // the tree doc and each file doc are separate sessions on this wire.
        const connection = new DirectConnection({
          url: `${baseUrl}?token=${t}`,
          transports: [websocketTransport({ timeout: 5000 }), httpTransport()],
        });
        const p = await Provider.create({
          connection,
          document: "file-system",
          encryptionKey: await createEncryptionKey(),
          // The example server keeps documents in memory, so restoring stale
          // IndexedDB state across dev-server restarts would resurrect old
          // document histories. Keep client persistence off to match.
          enableOfflinePersistence: false,
        });
        p.awareness.setLocalStateField("user", {
          name: userName,
          color: userColor,
        });
        if (!cancelled) {
          setSession({ provider: p, connection });
        } else {
          p.destroy({ destroyConnection: false });
          connection.destroy();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to initialize");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen text-lg text-gray-500">
        Connecting to collaborative workspace...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-screen text-lg text-red-600">
        Error: {error}
      </div>
    );
  }
  if (!session) return null;

  return (
    <Workspace
      provider={session.provider}
      connection={session.connection}
      user={{ name: userName, color: userColor }}
    />
  );
}

function useTree<T>(tree: MovableTree<T>) {
  useSyncExternalStore(
    useCallback((cb: () => void) => tree.onChange(cb), [tree]),
    useCallback(() => tree.opCount, [tree]),
  );
}

/** Build a breadcrumb path for a node, skipping the pseudo-root. */
function getNodePath(node: TreeNode<FileMeta>): string[] {
  return node.path
    .filter((n) => n.id !== "__root__" && n.id !== "__trash__")
    .map((n) => n.meta?.name ?? "Unknown");
}

function Workspace({
  provider,
  connection,
  user,
}: {
  provider: Provider;
  connection: DirectConnection;
  user: { name: string; color: string };
}) {
  const tree = useMemo(() => new MovableTree<FileMeta>(provider.doc), [provider]);
  useTree(tree);

  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // Preloaded providers for all file nodes
  const preloadedProviders = useRef<Map<string, Provider>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const unsub = tree.onChange(() => {
      if (tree.root.children.length > 0) cancelled = true;
    });
    (async () => {
      try {
        await provider.synced;
      } catch {
        /* disconnected -- seed anyway */
      }
      if (cancelled || tree.root.children.length > 0) return;

      // Seed in a single transaction: the whole default layout syncs as one
      // update instead of a burst of six.
      provider.doc.transact(() => {
        const documents = tree.root.createChild({ name: "Documents", type: "folder" });
        documents.createChild({ name: "Welcome.md", type: "file" });
        documents.createChild({ name: "Getting Started.md", type: "file" });
        const src = tree.root.createChild({ name: "src", type: "folder" });
        src.createChild({ name: "index.ts", type: "file" });
        src.createChild({ name: "utils.ts", type: "file" });
      });
    })();
    return () => {
      cancelled = true;
      unsub();
    };
  }, [tree, provider]);

  // Eagerly preload providers for all file nodes
  useEffect(() => {
    const currentFileIds = new Set<string>();

    for (const node of tree.nodes()) {
      if (node.meta?.type === "file" && !node.isDeleted) {
        currentFileIds.add(node.id);
        if (!preloadedProviders.current.has(node.id)) {
          // Start creating the provider immediately
          const nodeId = node.id;
          // Set a null placeholder so we don't start a duplicate
          preloadedProviders.current.set(nodeId, null as any);
          Provider.create({
            connection,
            document: `file/${nodeId}`,
            encryptionKey: createEncryptionKey(),
            enableOfflinePersistence: false,
          }).then((p) => {
            p.awareness.setLocalStateField("user", {
              name: user.name,
              color: user.color,
            });
            // Store if the entry is still our null placeholder (node not deleted)
            if (preloadedProviders.current.get(nodeId) === null) {
              preloadedProviders.current.set(nodeId, p);
            } else {
              p.destroy({ destroyConnection: false });
            }
          });
        }
      }
    }

    // Clean up providers for deleted/removed nodes
    for (const [nodeId, p] of preloadedProviders.current) {
      if (!currentFileIds.has(nodeId)) {
        if (p) p.destroy({ destroyConnection: false });
        preloadedProviders.current.delete(nodeId);
      }
    }
  }, [tree.opCount, connection, user.name, user.color]);

  useEffect(() => {
    setOpenTabs((prev) => {
      const kept = prev.filter((id) => tree.has(id) && !tree.getNode(id)?.isDeleted);
      return kept.length !== prev.length ? kept : prev;
    });
  }, [tree.opCount]);

  useEffect(() => {
    if (activeTab && (!tree.has(activeTab) || tree.getNode(activeTab)?.isDeleted)) {
      setActiveTab(openTabs[0] ?? null);
    }
  }, [activeTab, openTabs, tree.opCount]);

  const handleOpenFile = useCallback((nodeId: string) => {
    setOpenTabs((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
    setActiveTab(nodeId);
  }, []);

  const handleCreateFile = useCallback((parent: TreeNode<FileMeta>, name: string) => {
    const node = parent.createChild({ name, type: "file" });
    setOpenTabs((prev) => [...prev, node.id]);
    setActiveTab(node.id);
  }, []);

  const handleCreateFolder = useCallback((_parent: TreeNode<FileMeta>, name: string) => {
    _parent.createChild({ name, type: "folder" });
  }, []);

  const handleCloseTab = useCallback(
    (nodeId: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((id) => id !== nodeId);
        if (activeTab === nodeId) {
          const idx = prev.indexOf(nodeId);
          setActiveTab(next[Math.min(idx, next.length - 1)] ?? null);
        }
        return next;
      });
    },
    [activeTab],
  );

  // Compute activeFolder: the parent folder of the active file, or root
  const activeFolder = useMemo(() => {
    if (activeTab) {
      const node = tree.getNode(activeTab);
      if (node) {
        if (node.meta?.type === "folder") return node;
        const parent = node.parent;
        if (parent && parent.id !== "__root__" && parent.id !== "__trash__") return parent;
      }
    }
    return tree.root;
  }, [activeTab, tree, tree.opCount]);

  // Compute breadcrumb path for active file
  const breadcrumb = useMemo(() => {
    if (!activeTab) return null;
    const node = tree.getNode(activeTab);
    if (!node) return null;
    return getNodePath(node);
  }, [activeTab, tree, tree.opCount]);

  return (
    <div className="flex h-screen bg-white dark:bg-gray-950">
      <FileTree
        tree={tree}
        activeFileId={activeTab}
        activeFolder={activeFolder}
        onOpenFile={handleOpenFile}
        onCreateFile={handleCreateFile}
        onCreateFolder={handleCreateFolder}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TabBar
          tabs={openTabs}
          activeTab={activeTab}
          tree={tree}
          onSelectTab={setActiveTab}
          onCloseTab={handleCloseTab}
        />
        {breadcrumb && breadcrumb.length > 0 && (
          <div className="flex items-center gap-1 px-4 h-6 bg-gray-50 dark:bg-[#252526] border-b border-gray-200 dark:border-gray-800 text-[11px] text-gray-500 dark:text-gray-400 flex-shrink-0">
            {breadcrumb.map((segment, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-gray-300 dark:text-gray-600">{">"}</span>}
                <span
                  className={i === breadcrumb.length - 1 ? "text-gray-700 dark:text-gray-300" : ""}
                >
                  {segment}
                </span>
              </span>
            ))}
          </div>
        )}
        {openTabs.length > 0 ? (
          openTabs.map((tabId) => (
            <div
              key={tabId}
              className={tabId === activeTab ? "flex-1 flex flex-col min-h-0" : "hidden"}
            >
              <FileEditor
                nodeId={tabId}
                connection={connection}
                user={user}
                preloadedProvider={preloadedProviders.current.get(tabId) ?? undefined}
              />
            </div>
          ))
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-600 select-none">
            <div className="text-center">
              <svg
                className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-700"
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
              <p className="text-lg">Select a file to start editing</p>
              <p className="text-sm mt-1">Click a file in the sidebar or create a new one</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
