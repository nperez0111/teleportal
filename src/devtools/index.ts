import { SettingsManager } from "./settings-manager";
import { EventManager } from "./event-manager";
import { FilterManager } from "./filter-manager";
import { DevtoolsLayout } from "./components/devtools-layout";
import { devtoolsStyles } from "./styles";

const STYLE_ID = "teleportal-devtools-styles";

function injectStyles() {
  let styleElement = document.getElementById(
    STYLE_ID,
  ) as HTMLStyleElement | null;

  if (styleElement) {
    // Update existing styles (for hot-reload)
    styleElement.textContent = devtoolsStyles;
  } else {
    // Create new style element
    styleElement = document.createElement("style");
    styleElement.id = STYLE_ID;
    styleElement.textContent = devtoolsStyles;
    document.head.append(styleElement);
  }
}
export type DevtoolsState = ReturnType<typeof getDevtoolsState>;

export function getDevtoolsState() {
  const settingsManager = new SettingsManager();
  const eventManager = new EventManager(settingsManager);
  const filterManager = new FilterManager(settingsManager);
  return {
    settingsManager,
    eventManager,
    filterManager,
  };
}

export function createTeleportalDevtools(
  {
    settingsManager,
    eventManager,
    filterManager,
  }: DevtoolsState = getDevtoolsState(),
): HTMLElement {
  injectStyles();

  const layout = new DevtoolsLayout(settingsManager, filterManager);

  const updateUI = () => {
    const messages = eventManager.getMessages();
    const connectionState = eventManager.getConnectionState();
    const statistics = eventManager.getStatistics();
    const filters = filterManager.getFilters();
    const filteredMessages = filterManager.getFilteredMessages(messages);
    const availableDocuments = filterManager.getAvailableDocuments(messages);
    const availableMessageTypes =
      filterManager.getAvailableMessageTypes(messages);

    layout.update(
      messages,
      filteredMessages,
      connectionState,
      statistics,
      availableDocuments,
      availableMessageTypes,
      filters,
    );
  };

  const unsubscribeEventManager = eventManager.subscribe(updateUI);
  const unsubscribeFilterManager = filterManager.subscribe(updateUI);
  const unsubscribeSettingsManager = settingsManager.subscribe(updateUI);

  updateUI();

  const rootElement = layout.getElement();

  (rootElement as any).__teleportalDevtoolsCleanup = () => {
    unsubscribeEventManager();
    unsubscribeFilterManager();
    unsubscribeSettingsManager();
    eventManager.destroy();
  };

  return rootElement;
}
