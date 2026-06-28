import type { DevtoolsMessage } from "../types";
import { formatLogEntry } from "../utils/message-utils";
import { createMessageItem } from "./message-item";

export class MessageList {
  private element: HTMLElement;
  private messages: DevtoolsMessage[] = [];
  private selectedMessageId: string | null = null;
  private onSelectMessage: (message: DevtoolsMessage) => void;
  private onClearMessages: (() => void) | null = null;
  private listContainer: HTMLElement;
  private titleElement: HTMLElement;
  private itemElements = new Map<string, HTMLElement>();
  private itemMessages = new Map<string, DevtoolsMessage>();
  private renderedOrder: string[] = [];

  constructor(onSelectMessage: (message: DevtoolsMessage) => void, onClearMessages?: () => void) {
    this.onSelectMessage = onSelectMessage;
    this.onClearMessages = onClearMessages || null;
    this.element = document.createElement("div");
    this.element.className = "devtools-flex devtools-flex-col devtools-h-full devtools-bg-white";

    // Header
    const header = document.createElement("div");
    header.className = "devtools-list-header";
    this.titleElement = document.createElement("h2");
    this.titleElement.className = "devtools-list-header-title";
    header.append(this.titleElement);
    this.element.append(header);

    const btnGroup = document.createElement("div");
    btnGroup.className = "devtools-inspector-btn-group";

    const copyAllBtn = document.createElement("button");
    copyAllBtn.className = "devtools-button devtools-text-xs";
    copyAllBtn.textContent = "Copy Log";
    copyAllBtn.title = "Copy all visible messages as a log transcript for debugging";
    copyAllBtn.addEventListener("click", () => {
      const log = this.messages.map((m) => formatLogEntry(m)).join("\n");
      navigator.clipboard.writeText(log).then(() => {
        const original = copyAllBtn.textContent;
        copyAllBtn.textContent = "Copied!";
        setTimeout(() => {
          copyAllBtn.textContent = original;
        }, 1500);
      });
    });
    btnGroup.append(copyAllBtn);

    if (this.onClearMessages) {
      const clearButton = document.createElement("button");
      clearButton.className = "devtools-button devtools-text-xs";
      clearButton.textContent = "Clear";
      clearButton.title = "Clear all messages from memory";
      clearButton.addEventListener("click", () => {
        this.onClearMessages?.();
      });
      btnGroup.append(clearButton);
    }

    header.append(btnGroup);

    // List container
    this.listContainer = document.createElement("div");
    this.listContainer.className = "devtools-flex-1 devtools-overflow-y-auto";
    this.element.append(this.listContainer);

    this.updateTitle();
  }

  setMessages(messages: DevtoolsMessage[]) {
    this.messages = messages;
    this.updateTitle();
    this.reconcile();
  }

  setSelectedMessageId(messageId: string | null) {
    const prevId = this.selectedMessageId;
    this.selectedMessageId = messageId;

    if (prevId === messageId) return;

    if (prevId) {
      const oldEl = this.itemElements.get(prevId);
      if (oldEl) oldEl.classList.remove("devtools-bg-blue-50");
    }
    if (messageId) {
      const newEl = this.itemElements.get(messageId);
      if (newEl) newEl.classList.add("devtools-bg-blue-50");
    }
  }

  private updateTitle() {
    this.titleElement.textContent =
      this.messages.length === 1 ? "1 Message" : `${this.messages.length} Messages`;
  }

  private reconcile() {
    if (this.messages.length === 0) {
      if (this.renderedOrder.length > 0 || !this.listContainer.firstChild) {
        this.listContainer.innerHTML = "";
        this.itemElements.clear();
        this.itemMessages.clear();
        this.renderedOrder = [];
        const emptyState = document.createElement("div");
        emptyState.className =
          "devtools-p-4 devtools-text-center devtools-text-xs devtools-text-gray-500";
        emptyState.textContent = "No messages to display";
        this.listContainer.append(emptyState);
      }
      return;
    }

    // Newest first
    const newOrder: string[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      newOrder.push(this.messages[i].id);
    }

    const newSet = new Set(newOrder);

    // Remove items no longer present
    for (const id of this.renderedOrder) {
      if (!newSet.has(id)) {
        const el = this.itemElements.get(id);
        if (el) el.remove();
        this.itemElements.delete(id);
        this.itemMessages.delete(id);
      }
    }

    // Remove empty state if it was showing
    if (this.renderedOrder.length === 0 && this.listContainer.firstChild) {
      this.listContainer.innerHTML = "";
    }

    // Build/reorder items — walk the desired order and ensure DOM matches
    let refNode: ChildNode | null = null;
    for (let i = newOrder.length - 1; i >= 0; i--) {
      const id = newOrder[i];
      const msg = this.messages[this.messages.length - 1 - i];
      let el = this.itemElements.get(id);

      if (!el) {
        // New item
        el = createMessageItem(msg, this.selectedMessageId === id, () => {
          this.onSelectMessage(msg);
        });
        this.itemElements.set(id, el);
        this.itemMessages.set(id, msg);
        this.listContainer.insertBefore(el, refNode);
      } else {
        // Existing item — check if the message object changed (e.g. ackedBy added)
        const prevMsg = this.itemMessages.get(id);
        if (prevMsg !== msg) {
          const newEl = createMessageItem(msg, this.selectedMessageId === id, () => {
            this.onSelectMessage(msg);
          });
          this.listContainer.replaceChild(newEl, el);
          this.itemElements.set(id, newEl);
          this.itemMessages.set(id, msg);
          el = newEl;
        }

        // Ensure correct position
        if (el.nextSibling !== refNode) {
          this.listContainer.insertBefore(el, refNode);
        }
      }
      refNode = el;
    }

    this.renderedOrder = newOrder;
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
