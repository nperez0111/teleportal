import { SettingsManager } from "./settings-manager";
import { EventManager } from "./event-manager";
import { FilterManager } from "./filter-manager";
import { DevtoolsLayout } from "./components/devtools-layout";
import { devtoolsStyles } from "./styles";

const STYLE_ID = "teleportal-devtools-styles";

function injectStyles() {
  let styleElement = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

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
  { settingsManager, eventManager, filterManager }: DevtoolsState = getDevtoolsState(),
): HTMLElement {
  injectStyles();

  const layout = new DevtoolsLayout(
    settingsManager,
    filterManager,
    () => {
      eventManager.clearMessages();
    },
    (name: string) => {
      eventManager.switchTransport(name);
    },
  );

  const updateUI = () => {
    const messages = eventManager.getMessages();
    const generation = eventManager.getGeneration();
    const connectionState = eventManager.getConnectionState();
    const statistics = eventManager.getStatistics();
    const filters = filterManager.getFilters();
    const filteredMessages = filterManager.getFilteredMessages(messages, generation);
    const availableDocuments = filterManager.getAvailableDocuments(messages, generation);
    const availableMessageTypes = filterManager.getAvailableMessageTypes(messages, generation);

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

  let rafId: number | null = null;
  const scheduleUpdate = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateUI();
    });
  };

  const unsubscribeEventManager = eventManager.subscribe(scheduleUpdate);
  const unsubscribeFilterManager = filterManager.subscribe(scheduleUpdate);
  const unsubscribeSettingsManager = settingsManager.subscribe(scheduleUpdate);

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
