import type { DevtoolsMessage } from "../types";
import { createMessageItem } from "./message-item";

export class MessageList {
  private element: HTMLElement;
  private messages: DevtoolsMessage[] = [];
  private selectedMessageId: string | null = null;
  private onSelectMessage: (message: DevtoolsMessage) => void;
  private onClearMessages: (() => void) | null = null;
  private listContainer: HTMLElement;
  private header: HTMLElement;

  constructor(
    onSelectMessage: (message: DevtoolsMessage) => void,
    onClearMessages?: () => void,
  ) {
    this.onSelectMessage = onSelectMessage;
    this.onClearMessages = onClearMessages || null;
    this.element = document.createElement("div");
    this.element.className =
      "devtools-flex devtools-flex-col devtools-h-full devtools-bg-white";

    // Header - matches inspector header styling
    this.header = document.createElement("div");
    this.header.className = "devtools-list-header";
    const title = document.createElement("h2");
    title.className = "devtools-list-header-title";
    this.header.append(title);
    this.element.append(this.header);

    // Clear button
    if (this.onClearMessages) {
      const clearButton = document.createElement("button");
      clearButton.className = "devtools-button devtools-text-xs";
      clearButton.textContent = "Clear";
      clearButton.title = "Clear all messages from memory";
      clearButton.addEventListener("click", () => {
        this.onClearMessages?.();
      });
      this.header.append(clearButton);
    }

    // List container
    this.listContainer = document.createElement("div");
    this.listContainer.className = "devtools-flex-1 devtools-overflow-y-auto";
    this.element.append(this.listContainer);

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
      this.listContainer.append(emptyState);
      return;
    }

    // Render messages in reverse order (newest first)
    const reversed = [...this.messages].reverse();
    for (const message of reversed) {
      const isSelected = this.selectedMessageId === message.id;
      const item = createMessageItem(message, isSelected, () => {
        this.onSelectMessage(message);
      });
      this.listContainer.append(item);
    }
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
