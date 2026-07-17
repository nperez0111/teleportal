import { useEffect, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import { type DirectConnection, Provider } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

interface FileEditorProps {
  nodeId: string;
  connection: DirectConnection;
  user: { name: string; color: string };
  preloadedProvider?: Provider;
}

export function FileEditor({ nodeId, connection, user, preloadedProvider }: FileEditorProps) {
  const [provider, setProvider] = useState<Provider | null>(preloadedProvider ?? null);

  useEffect(() => {
    // If we already have a preloaded provider, use it directly
    if (preloadedProvider) {
      setProvider(preloadedProvider);
      return;
    }

    // Otherwise create a new one (fallback) on the shared connection
    let destroyed = false;
    let p: Provider | undefined;

    const init = async () => {
      p = await Provider.create({
        connection,
        document: `file/${nodeId}`,
        encryptionKey: await createEncryptionKey(),
        enableOfflinePersistence: false,
      });
      p.awareness.setLocalStateField("user", {
        name: user.name,
        color: user.color,
      });
      if (!destroyed) setProvider(p);
      else p.destroy({ destroyConnection: false });
    };
    init();

    return () => {
      destroyed = true;
      // Only destroy if we created it ourselves (not preloaded); the
      // connection is shared with every other document, so keep it alive.
      p?.destroy({ destroyConnection: false });
    };
  }, [nodeId, connection, preloadedProvider]);

  if (!provider) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-600">
        Loading document...
      </div>
    );
  }

  return <EditorView provider={provider} user={user} />;
}

function EditorView({
  provider,
  user,
}: {
  provider: Provider;
  user: { name: string; color: string };
}) {
  const editor = useCreateBlockNote({
    collaboration: {
      fragment: provider.doc.getXmlFragment("document"),
      user: {
        name: user.name,
        color: user.color,
      },
      provider: provider as any,
    },
  });

  return (
    <div className="flex-1 overflow-y-auto bg-white dark:bg-[#1e1e1e]">
      <BlockNoteView editor={editor} className="h-full" />
    </div>
  );
}
