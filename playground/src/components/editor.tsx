import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { websocket } from "teleportal/providers";
import "@blocknote/mantine/style.css";
import { use } from "react";

interface EditorProps {
  provider: websocket.Provider;
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
  });

  return (
    <div className="h-full w-full flex flex-col touch-manipulation">
      <BlockNoteView editor={editor} className="h-full w-full flex flex-col" />
    </div>
  );
}
