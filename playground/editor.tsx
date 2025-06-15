import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import { Provider } from "../src/server/provider";

export function Editor({ provider }: { provider: Provider }) {
  // Creates a new editor instance.
  const editor = useCreateBlockNote({
    collaboration: {
      fragment: provider.doc.getXmlFragment("document"),
      user: {
        name: "NICK THE SICK",
        color: "#" + Math.floor(Math.random() * 16777215).toString(16),
      },
      provider,
    },
  });

  // Renders the editor instance using a React component.
  return <BlockNoteView editor={editor} />;
}
