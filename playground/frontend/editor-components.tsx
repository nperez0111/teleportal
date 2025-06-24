import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { websocket } from "teleportal/providers";
import "@blocknote/mantine/style.css";

interface SingleEditorProps {
  provider: websocket.Provider;
}

export function SingleEditor({ provider }: SingleEditorProps) {
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

interface DocumentEditorProps {
  provider: websocket.Provider;
  documentName: string;
}

export function DocumentEditor({
  provider,
  documentName,
}: DocumentEditorProps) {
  return (
    <div>
      <h3>Document: {documentName}</h3>
      <SingleEditor key={documentName + "-editor"} provider={provider} />
    </div>
  );
}
