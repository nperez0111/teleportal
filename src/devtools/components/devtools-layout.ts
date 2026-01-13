import { MessageList } from "./message-list";
import { MessageInspector } from "./message-inspector";
import { FiltersPanel } from "./filters-panel";
import type {
  DevtoolsMessage,
  Statistics,
  ConnectionStateInfo,
} from "../types";
import type { SettingsManager } from "../settings-manager";
import type { FilterManager } from "../filter-manager";

export class DevtoolsLayout {
  private element: HTMLElement;
  private messageList: MessageList;
  private messageInspector: MessageInspector;
  private filtersPanel: FiltersPanel;
  private selectedMessage: DevtoolsMessage | null = null;

  constructor(
    settingsManager: SettingsManager,
    filterManager: FilterManager,
  ) {
    this.element = document.createElement("div");
    this.element.className =
      "devtools-container devtools-h-full devtools-w-full";

    // Create filters panel
    this.filtersPanel = new FiltersPanel(
      settingsManager,
      (updates) => {
        filterManager.updateFilters(updates);
      },
      () => {
        filterManager.clearFilters();
      },
    );

    // Create message list
    this.messageList = new MessageList((message) => {
      this.selectedMessage = message;
      this.messageInspector.setMessage(message);
      this.messageList.setSelectedMessageId(message.id);
    });

    // Create message inspector
    this.messageInspector = new MessageInspector();

    // Build layout
    // Top: Filters panel
    const filtersContainer = document.createElement("div");
    filtersContainer.className = "devtools-shrink-0 devtools-border-b devtools-border-gray-200";
    filtersContainer.appendChild(this.filtersPanel.getElement());
    this.element.appendChild(filtersContainer);

    // Main content area
    const mainContent = document.createElement("div");
    mainContent.className =
      "devtools-flex-1 devtools-flex devtools-overflow-hidden";

    // Left: Message List
    const messageListContainer = document.createElement("div");
    messageListContainer.className =
      "devtools-flex-1 devtools-min-w-0 devtools-border-r devtools-border-gray-200";
    messageListContainer.appendChild(this.messageList.getElement());
    mainContent.appendChild(messageListContainer);

    // Right: Message Inspector
    const inspectorContainer = document.createElement("div");
    inspectorContainer.className = "devtools-w-96 devtools-shrink-0";
    inspectorContainer.appendChild(this.messageInspector.getElement());
    mainContent.appendChild(inspectorContainer);

    this.element.appendChild(mainContent);
  }

  update(
    messages: DevtoolsMessage[],
    filteredMessages: DevtoolsMessage[],
    connectionState: ConnectionStateInfo | null,
    statistics: Statistics | null,
    availableDocuments: string[],
    availableMessageTypes: string[],
    filters: any,
  ) {
    this.messageList.setMessages(filteredMessages);
    if (this.selectedMessage) {
      const stillExists = filteredMessages.some(
        (m) => m.id === this.selectedMessage!.id,
      );
      if (!stillExists) {
        this.selectedMessage = null;
        this.messageInspector.setMessage(null);
        this.messageList.setSelectedMessageId(null);
      } else {
        this.messageList.setSelectedMessageId(this.selectedMessage.id);
      }
    }

    this.filtersPanel.update(
      filters,
      connectionState,
      statistics,
      availableDocuments,
      availableMessageTypes,
    );
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
