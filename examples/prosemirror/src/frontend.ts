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
import { createTeleportalDevtools, getDevtoolsState } from "teleportal/devtools";
import { TanStackDevtoolsCore } from "@tanstack/devtools";

const baseUrl = new URL("./", document.baseURI).href;

const res = await fetch(new URL("api/token", baseUrl).href, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userId: "user-" + Math.floor(Math.random() * 1000) }),
});
const { token } = await res.json();

const provider = await Provider.create({
  url: `${baseUrl}?token=${token}`,
  document: "prosemirror-demo",
  encryptionKey: false,
});

await provider.synced;

const type = provider.doc.getXmlFragment("prosemirror");
const { doc, mapping } = initProseMirrorDoc(type, schema);

const editorEl = document.getElementById("editor")!;
const view = new EditorView(editorEl, {
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

provider.awareness.setLocalStateField("user", {
  name: "User " + Math.floor(Math.random() * 100),
  color:
    "#" +
    Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0"),
});

setTimeout(() => view.focus());

const state = getDevtoolsState();
const devtools = new TanStackDevtoolsCore({
  plugins: [
    {
      name: "TelePortal",
      render(el) {
        el.appendChild(createTeleportalDevtools(state));
      },
    },
  ],
});
devtools.mount(document.body);
