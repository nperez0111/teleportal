import React from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "./editor";
import { Provider } from "../src/server/provider";

const provider = await Provider.create({
  url: "ws://localhost:1234/_ws",
  document: "test",
});

const root = createRoot(document.getElementById("root")!);
root.render(
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(Editor, { provider }),
  ),
);
