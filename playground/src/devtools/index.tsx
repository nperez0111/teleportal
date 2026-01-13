import { DevtoolsLayout } from "./components/DevtoolsLayout";
import { useTeleportalEvents } from "./hooks/useTeleportalEvents";

export function TeleportalDevtoolsPanelReact() {
  const { messages, connectionState, statistics } = useTeleportalEvents();

  return (
    <DevtoolsLayout
      messages={messages}
      statistics={statistics}
      connectionState={connectionState}
    />
  );
}
