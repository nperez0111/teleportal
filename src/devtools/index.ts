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
export type DevtoolsState = ReturnType<typeof createDevtoolsState>;

/**
 * Creates a fresh, isolated devtools state. Most integrations should use
 * {@link getDevtoolsState} instead so history survives panel close/open.
 */
export function createDevtoolsState() {
  const settingsManager = new SettingsManager();
  const eventManager = new EventManager(settingsManager);
  const filterManager = new FilterManager(settingsManager);
  return {
    settingsManager,
    eventManager,
    filterManager,
  };
}

let sharedState: DevtoolsState | null = null;

/**
 * Returns the shared devtools state, creating it on first call. The state
 * keeps collecting messages, documents, presence, and the connection timeline
 * while the panel is closed (bounded by the message limit), so reopening the
 * devtools shows history instead of starting empty.
 */
export function getDevtoolsState(): DevtoolsState {
  if (!sharedState) {
    sharedState = createDevtoolsState();
  }
  return sharedState;
}

/**
 * Tears down the shared state entirely: unsubscribes from all teleportal
 * events and drops collected history. Only needed when the host app wants to
 * stop background collection — closing the panel doesn't require this.
 */
export function destroyDevtoolsState() {
  if (sharedState) {
    sharedState.eventManager.destroy();
    sharedState = null;
  }
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
    {
      getConnectionState: () => eventManager.getConnectionState(),
      getConnection: () => eventManager.getConnection(),
      getTimeline: () => eventManager.getConnectionTimeline(),
      getStatistics: () => eventManager.getStatistics(),
      getLastConnectedAt: () => eventManager.getLastConnectedAt(),
    },
  );

  const updateUI = () => {
    const messages = eventManager.getMessages();
    const generation = eventManager.getGeneration();

    layout.update({
      filteredMessages: filterManager.getFilteredMessages(messages, generation),
      connectionState: eventManager.getConnectionState(),
      statistics: eventManager.getStatistics(),
      availableDocuments: filterManager.getAvailableDocuments(messages, generation),
      availableMessageTypes: filterManager.getAvailableMessageTypes(messages, generation),
      filters: filterManager.getFilters(),
      documents: eventManager.getDocuments(),
      presencePeers: eventManager.getPresencePeers(),
      presenceFeed: eventManager.getPresenceFeed(),
      transferProgress: eventManager.getTransferProgress(),
    });
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

  // Detaches the UI only. The state object (and its event subscriptions) is
  // owned by the caller — the shared state from getDevtoolsState() keeps
  // collecting so a reopened panel shows history. Use destroyDevtoolsState()
  // to stop collection entirely.
  (rootElement as any).__teleportalDevtoolsCleanup = () => {
    unsubscribeEventManager();
    unsubscribeFilterManager();
    unsubscribeSettingsManager();
    layout.destroy();
  };

  return rootElement;
}
