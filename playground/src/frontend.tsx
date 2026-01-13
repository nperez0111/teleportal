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
      config={{
        customTrigger: (
          <img
            src="https://github.com/nperez0111/teleportal/blob/main/assets/pepper.svg?raw=true"
            width={60}
            height={60}
          />
        ),
      }}
      plugins={[
        {
          name: "TelePortal",
          render: <TeleportalDevtoolsPanelReact />,
          defaultOpen: true,
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
