import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { websocket } from "teleportal/providers";
import "@blocknote/mantine/style.css";

interface EditorProps {
  provider?: websocket.Provider;
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
  });

  return <BlockNoteView editor={editor} />;
}
