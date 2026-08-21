import { useEffect, useRef, useState } from "react";
import {
  ySyncPlugin,
  yCursorPlugin,
  yUndoPlugin,
  undo,
  redo,
  initProseMirrorDoc,
} from "y-prosemirror";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { exampleSetup } from "prosemirror-example-setup";
import { keymap } from "prosemirror-keymap";
import { Provider } from "teleportal/providers";
import { registryKey, importWrappingKey } from "teleportal/encryption-key";
import { createKeyRegistryRpc } from "teleportal/protocols/key-registry";

const USER_COLORS: Record<string, { color: string; light: string }> = {
  alice: { color: "#8b5cf6", light: "#8b5cf633" },
  bob: { color: "#3b82f6", light: "#3b82f633" },
  eve: { color: "#ef4444", light: "#ef444433" },
};

const roleBadgeStyles: Record<string, string> = {
  admin: "bg-violet-100 text-violet-700 border-violet-200",
  editor: "bg-blue-100 text-blue-700 border-blue-200",
  viewer: "bg-gray-100 text-gray-600 border-gray-200",
};

export type UserSessionProps = {
  userId: string;
  displayName: string;
  role: string;
  status: "connecting" | "connected" | "revoked" | "reminted";
  token: string;
  wrappingKey: string;
  providerKey: number;
  documentId: string;
  room: string;
  lastSeenContent: string | null;
  lastSeenTimestamp: number | null;
  keyRotatedSinceRevoke: boolean;
  onStatusChange: (userId: string, status: "connecting" | "connected") => void;
  onContentSnapshot: (userId: string, content: string) => void;
  onEvent: (message: string, type: "info" | "success" | "warning" | "error" | "crypto") => void;
};

export function UserSession(props: UserSessionProps) {
  if (props.status === "revoked") {
    return (
      <FrozenSession
        displayName={props.displayName}
        role={props.role}
        lastSeenContent={props.lastSeenContent}
        lastSeenTimestamp={props.lastSeenTimestamp}
        keyRotatedSinceRevoke={props.keyRotatedSinceRevoke}
      />
    );
  }

  if (props.status === "reminted") {
    return (
      <div className="rounded-lg border border-amber-200 bg-white overflow-hidden flex flex-col h-72">
        <SessionHeader displayName={props.displayName} role={props.role} status="reminted" />
        <div className="flex-1 flex items-center justify-center bg-amber-50/30 p-4">
          <div className="text-center max-w-52">
            <div className="text-2xl mb-2">&#x1F511;</div>
            <p className="text-xs font-semibold text-amber-700 mb-1">New Key Issued</p>
            <p className="text-[10px] text-amber-600">
              Key re-minted with current document key. Historical content was encrypted with a
              previous key and is not accessible.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ActiveSession
      key={props.providerKey}
      userId={props.userId}
      displayName={props.displayName}
      role={props.role}
      status={props.status}
      token={props.token}
      wrappingKey={props.wrappingKey}
      documentId={props.documentId}
      room={props.room}
      onStatusChange={props.onStatusChange}
      onContentSnapshot={props.onContentSnapshot}
      onEvent={props.onEvent}
    />
  );
}

function FrozenSession({
  displayName,
  role,
  lastSeenContent,
  lastSeenTimestamp,
  keyRotatedSinceRevoke,
}: {
  displayName: string;
  role: string;
  lastSeenContent: string | null;
  lastSeenTimestamp: number | null;
  keyRotatedSinceRevoke: boolean;
}) {
  return (
    <div className="rounded-lg border border-red-200 bg-white overflow-hidden flex flex-col h-72">
      <SessionHeader displayName={displayName} role={role} status="revoked" />
      <div className="flex-1 relative overflow-hidden">
        {lastSeenContent ? (
          <>
            <div
              className="ProseMirror px-3 py-2 text-sm text-gray-600 opacity-50"
              dangerouslySetInnerHTML={{ __html: lastSeenContent }}
            />
            <div className="absolute inset-0 bg-red-50/40 pointer-events-none" />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-3xl">&#x1F512;</div>
          </div>
        )}
        <div className="absolute bottom-0 inset-x-0 bg-white/90 border-t border-red-100 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-red-600 uppercase">Access Revoked</span>
            {lastSeenTimestamp && (
              <span className="text-[10px] text-gray-400">
                — frozen at{" "}
                {new Date(lastSeenTimestamp).toLocaleTimeString("en-US", {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            )}
          </div>
          {keyRotatedSinceRevoke && (
            <p className="text-[10px] text-amber-600">
              Document key rotated — permanently excluded. New content uses a different encryption
              key.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionHeader({
  displayName,
  role,
  status,
}: {
  displayName: string;
  role: string;
  status: string;
}) {
  const statusDot =
    status === "connected"
      ? "bg-emerald-500"
      : status === "revoked"
        ? "bg-red-500"
        : status === "error" || status === "reminted"
          ? "bg-amber-500"
          : "bg-amber-400";
  const statusLabel =
    status === "connected"
      ? "Connected"
      : status === "revoked"
        ? "Revoked"
        : status === "error" || status === "reminted"
          ? "Re-minted"
          : "Connecting...";

  return (
    <div className="px-3 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-900">{displayName}</span>
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${roleBadgeStyles[role] ?? roleBadgeStyles.viewer}`}
        >
          {role}
        </span>
      </div>
      <span className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${statusDot}`} />
        {statusLabel}
      </span>
    </div>
  );
}

function ActiveSession({
  userId,
  displayName,
  role,
  token,
  wrappingKey,
  documentId,
  onStatusChange,
  onContentSnapshot,
  onEvent,
}: Omit<
  UserSessionProps,
  "providerKey" | "lastSeenContent" | "lastSeenTimestamp" | "keyRotatedSinceRevoke" | "status"
> & { status?: string }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<Provider | null>(null);
  const [editorStatus, setEditorStatus] = useState<"connecting" | "connected" | "error">(
    "connecting",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let provider: Provider | null = null;
    let view: EditorView | null = null;
    let destroyed = false;

    async function init() {
      try {
        const baseUrl = new URL("./", window.location.href).href;
        const resolver = registryKey({
          wrappingKey: await importWrappingKey(wrappingKey),
        });

        provider = await Provider.create({
          url: `${baseUrl}?token=${token}`,
          document: documentId,
          encryptionKey: resolver,
          rpc: { keys: createKeyRegistryRpc },
          enableOfflinePersistence: false,
        });

        if (destroyed) {
          provider.destroy();
          return;
        }

        providerRef.current = provider;

        const colors = USER_COLORS[userId] ?? { color: "#6b7280", light: "#6b728033" };
        provider.awareness.setLocalStateField("user", {
          name: displayName,
          color: colors.color,
          colorLight: colors.light,
        });

        await provider.synced;

        if (destroyed) {
          provider.destroy();
          return;
        }

        const type = provider.doc.getXmlFragment("document");
        const { doc, mapping } = initProseMirrorDoc(type, schema);

        const editable = role !== "viewer";

        view = new EditorView(editorRef.current!, {
          state: EditorState.create({
            doc,
            schema,
            plugins: [
              ySyncPlugin(type, { mapping }),
              yCursorPlugin(provider.awareness),
              yUndoPlugin(),
              keymap({
                "Mod-z": undo,
                "Mod-y": redo,
                "Mod-Shift-z": redo,
              }),
            ].concat(exampleSetup({ schema, history: false })),
          }),
          editable: () => editable,
        });

        if (!destroyed) {
          setEditorStatus("connected");
          onStatusChange(userId, "connected");
          onEvent(`${displayName} connected (${role})`, "success");
        }

        const keysRpc = provider.rpc?.keys;
        if (keysRpc) {
          keysRpc.onKeysRotated(() => {
            onEvent(`${displayName} re-keyed with new document key`, "crypto");
          });
        }
      } catch (err) {
        if (!destroyed) {
          const msg = err instanceof Error ? err.message : "unknown error";
          const isDecryptErr =
            msg.toLowerCase().includes("decrypt") || msg.includes("OperationError");
          setEditorStatus("error");
          setErrorMsg(
            isDecryptErr
              ? "Cannot decrypt historical content — document was re-encrypted with a new key"
              : msg,
          );
          onEvent(`${displayName} failed to connect: ${msg}`, "error");
          // Destroy provider to stop receiving messages we can't decrypt
          view?.destroy();
          view = null;
          provider?.destroy();
          provider = null;
          providerRef.current = null;
        }
      }
    }

    init();

    return () => {
      destroyed = true;
      if (provider) {
        try {
          const fragment = provider.doc.getXmlFragment("document");
          const content = fragment.toJSON();
          onContentSnapshot(userId, content);
        } catch {
          // best-effort snapshot
        }
      }
      view?.destroy();
      provider?.destroy();
      providerRef.current = null;
    };
  }, [token, wrappingKey, documentId, userId]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden flex flex-col h-72">
      <SessionHeader displayName={displayName} role={role} status={editorStatus} />
      {editorStatus === "error" ? (
        <div className="flex-1 flex items-center justify-center bg-amber-50/50 p-4">
          <div className="text-center max-w-52">
            <div className="text-2xl mb-2">&#x1F511;</div>
            <p className="text-xs font-semibold text-amber-700 mb-1">New Key Issued</p>
            <p className="text-[10px] text-amber-600">{errorMsg}</p>
          </div>
        </div>
      ) : (
        <div ref={editorRef} className="flex-1 overflow-y-auto" />
      )}
    </div>
  );
}
