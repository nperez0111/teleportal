import type { DevtoolsMessage } from "../types";
import { createMessageItem } from "./message-item";

export class MessageList {
  private element: HTMLElement;
  private messages: DevtoolsMessage[] = [];
  private selectedMessageId: string | null = null;
  private onSelectMessage: (message: DevtoolsMessage) => void;
  private listContainer: HTMLElement;

  constructor(onSelectMessage: (message: DevtoolsMessage) => void) {
    this.onSelectMessage = onSelectMessage;
    this.element = document.createElement("div");
    this.element.className =
      "devtools-flex devtools-flex-col devtools-h-full devtools-bg-white";

    // Header - matches inspector header styling
    const header = document.createElement("div");
    header.className = "devtools-list-header";
    const title = document.createElement("h2");
    title.className = "devtools-list-header-title";
    header.appendChild(title);
    this.element.appendChild(header);

    // List container
    this.listContainer = document.createElement("div");
    this.listContainer.className = "devtools-flex-1 devtools-overflow-y-auto";
    this.element.appendChild(this.listContainer);

    this.updateTitle();
    this.render();
  }

  setMessages(messages: DevtoolsMessage[]) {
    this.messages = messages;
    this.updateTitle();
    this.render();
  }

  setSelectedMessageId(messageId: string | null) {
    this.selectedMessageId = messageId;
    this.render();
  }

  private updateTitle() {
    const title = this.element.querySelector("h2");
    if (title) {
      title.textContent =
        this.messages.length === 1
          ? "1 Message"
          : `${this.messages.length} Messages`;
    }
  }

  private render() {
    this.listContainer.innerHTML = "";

    if (this.messages.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className =
        "devtools-p-4 devtools-text-center devtools-text-xs devtools-text-gray-500";
      emptyState.textContent = "No messages to display";
      this.listContainer.appendChild(emptyState);
      return;
    }

    // Render messages in reverse order (newest first)
    const reversed = [...this.messages].reverse();
    reversed.forEach((message) => {
      const isSelected = this.selectedMessageId === message.id;
      const item = createMessageItem(message, isSelected, () => {
        this.onSelectMessage(message);
      });
      this.listContainer.appendChild(item);
    });
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
