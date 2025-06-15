import React from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "./editor";

const root = createRoot(document.getElementById("root")!);
root.render(
  React.createElement(React.StrictMode, null, React.createElement(Editor)),
);
