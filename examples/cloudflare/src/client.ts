/**
 * Browser client, bundled locally (`bun run build:client`) so the wire
 * protocol always matches the server built from this repo.
 */
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { exampleSetup } from "prosemirror-example-setup";
import { keymap } from "prosemirror-keymap";
import { initProseMirrorDoc, redo, undo, yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";

import { Provider } from "teleportal/providers";

// WebSocket with automatic HTTP/SSE fallback; both land on /api.
// This demo skips end-to-end encryption — see teleportal/encryption-key for
// the real thing (it runs fine on workerd).
const provider = await Provider.create({
  url: `${window.location.origin}/api`,
  document: "test",
  encryptionKey: false,
});

await provider.synced;

const type = provider.doc.getXmlFragment("prosemirror");

const editor = document.createElement("div");
editor.setAttribute("id", "editor");
const editorContainer = document.createElement("div");
editorContainer.insertBefore(editor, null);
const { doc, mapping } = initProseMirrorDoc(type, schema);
const prosemirrorView = new EditorView(editor, {
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
});
document.body.insertBefore(editorContainer, null);

setTimeout(() => {
  prosemirrorView.focus();
});
