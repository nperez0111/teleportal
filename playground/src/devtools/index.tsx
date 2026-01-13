import { DevtoolsLayout } from "./components/DevtoolsLayout";
import { useTeleportalEvents } from "./hooks/useTeleportalEvents";

export function TeleportalDevtoolsPanelReact() {
  const { messages, connectionState, documents, statistics, clearMessages } =
    useTeleportalEvents();

  return (
    <DevtoolsLayout
      messages={messages}
      statistics={statistics}
      onClearMessages={clearMessages}
    />
  );
}
