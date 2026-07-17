import { createRoot } from "react-dom/client";
import { TanStackDevtools } from "@tanstack/react-devtools";
import Shell from "./components/shell";
import { TeleportalDevtoolsPanelReact } from "./devtools";

const elem = document.getElementById("root")!;
const app = (
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
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  createRoot(elem).render(app);
}
