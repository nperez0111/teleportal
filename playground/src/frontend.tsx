import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./components/shell";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { TeleportalDevtoolsPanelReact } from "./devtools";

const elem = document.getElementById("root")!;
const app = (
  // <StrictMode>
  <>
    <Shell />

    <TanStackDevtools
      plugins={[
        {
          name: "TelePortal",
          render: <TeleportalDevtoolsPanelReact />,
        },
      ]}
    />
  </>
  // </StrictMode>
);

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  // The hot module reloading API is not available in production.
  createRoot(elem).render(app);
}
