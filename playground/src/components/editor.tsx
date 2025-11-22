import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { DefaultTransportProperties, Provider } from "teleportal/providers";
import "@blocknote/mantine/style.css";
import { use } from "react";
import { ClientContext, Transport } from "teleportal";
import { FileTransportMethods } from "teleportal/transports";

interface EditorProps {
  provider: Provider<
    Transport<ClientContext, DefaultTransportProperties & FileTransportMethods>
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

export function Editor({ provider, user }: EditorProps) {
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
        console.log("uploading file", file, blockId);
        const fileId = await provider.transport.upload(
          file,
          provider.document,
          blockId,
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
        console.log("downloading file", url, fileId);
        const file = await provider.transport.download(
          fileId,
          provider.document,
        );
        console.log("file downloaded", file);
        return URL.createObjectURL(file);
      }
      return url;
    },
  });

  return (
    <div className="h-full w-full flex flex-col touch-manipulation">
      <BlockNoteView editor={editor} className="h-full w-full flex flex-col" />
    </div>
  );
}
