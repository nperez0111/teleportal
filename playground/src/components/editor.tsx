import { ForkYDocExtension } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import { use, useEffect } from "react";
import { ClientContext, Milestone, Transport } from "teleportal";
import { DefaultTransportProperties, Provider } from "teleportal/providers";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { EncryptionClient } from "../../../src/transports/encrypted/client";

interface EditorProps {
  selectedMilestone: Milestone | null;
  provider: Provider<
    Transport<
      ClientContext,
      DefaultTransportProperties & { handler?: EncryptionClient }
    >
  >;
  user?: {
    /**
     * The name of the user.
     */
    name: string;
    /**
     * A hex color code for the user's color.
     */
    color: string;
  };
}

export function Editor({ provider, user, selectedMilestone }: EditorProps) {
  use(provider.loaded);
  const editor = useCreateBlockNote({
    collaboration: provider
      ? {
          fragment: provider.doc.getXmlFragment("document"),
          user: {
            name: user?.name ?? "NICK THE SICK",
            color:
              user?.color ??
              "#" + Math.floor(Math.random() * 16777215).toString(16),
          },
          provider,
        }
      : undefined,
    domAttributes: {
      editor: {
        class: "flex-1 w-full min-h-full",
        style: "min-height: calc(100vh - 200px);",
      },
    },
    async uploadFile(file, blockId) {
      try {
        const fileId = await provider.uploadFile(
          file,
          blockId,
          provider.transport.handler?.key,
        );

        return `teleportal://${fileId}`;
      } catch (error) {
        console.error("Error uploading file:", error);
        return {};
      }
    },
    async resolveFileUrl(url) {
      if (url.startsWith("teleportal://")) {
        const fileId = url.split("://")[1];
        const file = await provider.downloadFile(
          fileId,
          provider.transport.handler?.key,
        );
        return URL.createObjectURL(file);
      }
      return url;
    },
  });

  useEffect(() => {
    let isActive = true;

    if (selectedMilestone) {
      selectedMilestone
        .fetchSnapshot()
        .then((snapshot) => {
          // Ignore if this effect has been cleaned up (milestone deselected)
          if (!isActive) return;

          editor.getExtension(ForkYDocExtension)?.fork();
          const doc = new Y.Doc();
          Y.applyUpdateV2(doc, snapshot);
          const node = yXmlFragmentToProseMirrorRootNode(
            doc.getXmlFragment("document"),
            editor.pmSchema,
          );
          editor.transact((tr) => {
            tr.replace(0, tr.doc.content.size - 2, node.slice(0));
          });
          // Destroy the temporary doc immediately after extracting the node
          doc.destroy();
        })
        .catch((error) => {
          // Only log errors if the effect is still active
          if (isActive) {
            console.error("Failed to fetch milestone snapshot:", error);
            // Optionally show user-facing error feedback here
          }
        });
    } else if (selectedMilestone === null) {
      editor.getExtension(ForkYDocExtension)?.merge({ keepChanges: false });
    }

    // Cleanup: restore original document state before switching to a new milestone
    return () => {
      isActive = false;
      // Only merge if we actually have an active fork
      // This handles transitions: milestone → null, milestone → milestone, and unmount
      const forkExtension = editor.getExtension(ForkYDocExtension);
      if (forkExtension?.store.state.isForked) {
        forkExtension.merge({ keepChanges: false });
      }
    };
  }, [selectedMilestone, editor]);

  return (
    <div className="h-full w-full flex flex-col touch-manipulation">
      <BlockNoteView editor={editor} className="h-full w-full flex flex-col" />
    </div>
  );
}
