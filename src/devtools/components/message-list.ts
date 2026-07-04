import type { FileTransferProgress } from "teleportal/protocols/file";
import type { DevtoolsMessage } from "../types";
import { formatLogEntry } from "../utils/message-utils";
import { buildRpcGroups, rpcGroupSignature, type RpcGroup } from "../utils/rpc-tracker";
import { createMessageItem } from "./message-item";
import { createRpcGroupItem } from "./rpc-group-item";

export type MessageListSelection = { kind: "message"; id: string } | { kind: "group"; key: string };

type RowModel =
  | { kind: "message"; key: string; msg: DevtoolsMessage }
  | { kind: "group"; key: string; group: RpcGroup }
  | { kind: "child"; key: string; msg: DevtoolsMessage };

export class MessageList {
  private element: HTMLElement;
  private messages: DevtoolsMessage[] = [];
  private selection: MessageListSelection | null = null;
  private onSelectMessage: (message: DevtoolsMessage) => void;
  private onSelectGroup: (group: RpcGroup) => void;
  private onClearMessages: (() => void) | null = null;
  private listContainer: HTMLElement;
  private titleElement: HTMLElement;
  private rowElements = new Map<string, HTMLElement>();
  private rowSignatures = new Map<string, unknown>();
  private renderedOrder: string[] = [];
  private expandedGroups = new Set<string>();
  private groups = new Map<string, RpcGroup>();

  constructor(
    onSelectMessage: (message: DevtoolsMessage) => void,
    onSelectGroup: (group: RpcGroup) => void,
    onClearMessages?: () => void,
  ) {
    this.onSelectMessage = onSelectMessage;
    this.onSelectGroup = onSelectGroup;
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

  setMessages(
    messages: DevtoolsMessage[],
    transferProgress?: ReadonlyMap<string, FileTransferProgress>,
  ) {
    this.messages = messages;
    this.groups = buildRpcGroups(messages, transferProgress).groups;
    this.updateTitle();
    this.reconcile();
  }

  getGroup(key: string): RpcGroup | undefined {
    return this.groups.get(key);
  }

  setSelection(selection: MessageListSelection | null) {
    const prevKey = this.selectionKey(this.selection);
    const nextKey = this.selectionKey(selection);
    this.selection = selection;

    if (prevKey === nextKey) return;

    if (prevKey) {
      const oldEl = this.rowElements.get(prevKey);
      if (oldEl) oldEl.classList.remove("devtools-bg-blue-50");
    }
    if (nextKey) {
      const newEl = this.rowElements.get(nextKey);
      if (newEl) newEl.classList.add("devtools-bg-blue-50");
    }
  }

  private selectionKey(selection: MessageListSelection | null): string | null {
    if (!selection) return null;
    return selection.kind === "group" ? `g:${selection.key}` : `m:${selection.id}`;
  }

  private isRowSelected(row: RowModel): boolean {
    if (!this.selection) return false;
    if (row.kind === "group") {
      return this.selection.kind === "group" && this.selection.key === row.key;
    }
    return this.selection.kind === "message" && this.selection.id === row.msg.id;
  }

  private updateTitle() {
    this.titleElement.textContent =
      this.messages.length === 1 ? "1 Message" : `${this.messages.length} Messages`;
  }

  /**
   * Builds display rows, newest first. RPC messages collapse into one group
   * row anchored at the call's oldest visible message; expanding a group
   * inserts its members chronologically (request → parts → response) below.
   */
  private buildRows(): RowModel[] {
    const rows: RowModel[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.message.type === "rpc") {
        const group = this.findGroupAnchoredAt(msg, i);
        if (!group) continue; // rendered at its anchor position
        rows.push({ kind: "group", key: `g:${group.key}`, group });
        if (this.expandedGroups.has(group.key)) {
          const members: DevtoolsMessage[] = [];
          if (group.request) members.push(group.request);
          members.push(...group.parts);
          if (group.response) members.push(group.response);
          for (const member of members) {
            rows.push({ kind: "child", key: `m:${member.id}`, msg: member });
          }
        }
      } else {
        rows.push({ kind: "message", key: `m:${msg.id}`, msg });
      }
    }
    return rows;
  }

  private groupKeyByMessageId = new Map<string, string>();

  private findGroupAnchoredAt(msg: DevtoolsMessage, index: number): RpcGroup | null {
    const key = this.groupKeyByMessageId.get(msg.id);
    if (!key) return null;
    const group = this.groups.get(key);
    if (!group) return null;
    return group.firstIndex === index ? group : null;
  }

  private renderRow(row: RowModel): HTMLElement {
    const selected = this.isRowSelected(row);
    switch (row.kind) {
      case "message":
        return createMessageItem(row.msg, selected, () => this.onSelectMessage(row.msg));
      case "child":
        return createMessageItem(row.msg, selected, () => this.onSelectMessage(row.msg), {
          child: true,
        });
      case "group":
        return createRpcGroupItem(
          row.group,
          selected,
          this.expandedGroups.has(row.group.key),
          () => this.onSelectGroup(row.group),
          () => {
            if (this.expandedGroups.has(row.group.key)) {
              this.expandedGroups.delete(row.group.key);
            } else {
              this.expandedGroups.add(row.group.key);
            }
            this.reconcile();
          },
        );
    }
  }

  private rowSignature(row: RowModel): unknown {
    if (row.kind === "group") {
      return `${rpcGroupSignature(row.group)}|${this.expandedGroups.has(row.group.key) ? 1 : 0}`;
    }
    // Message objects are replaced on change (e.g. ackedBy), so identity works.
    return row.msg;
  }

  private reconcile() {
    // Refresh message-id → group-key mapping (groups were rebuilt in setMessages)
    this.groupKeyByMessageId.clear();
    for (const group of this.groups.values()) {
      if (group.request) this.groupKeyByMessageId.set(group.request.id, group.key);
      for (const part of group.parts) this.groupKeyByMessageId.set(part.id, group.key);
      if (group.response) this.groupKeyByMessageId.set(group.response.id, group.key);
    }

    const rows = this.buildRows();

    if (rows.length === 0) {
      if (this.renderedOrder.length > 0 || !this.listContainer.firstChild) {
        this.listContainer.innerHTML = "";
        this.rowElements.clear();
        this.rowSignatures.clear();
        this.renderedOrder = [];
        const emptyState = document.createElement("div");
        emptyState.className =
          "devtools-p-4 devtools-text-center devtools-text-xs devtools-text-gray-500";
        emptyState.textContent = "No messages to display";
        this.listContainer.append(emptyState);
      }
      return;
    }

    const newOrder = rows.map((r) => r.key);
    const newSet = new Set(newOrder);

    // Remove rows no longer present
    for (const key of this.renderedOrder) {
      if (!newSet.has(key)) {
        const el = this.rowElements.get(key);
        if (el) el.remove();
        this.rowElements.delete(key);
        this.rowSignatures.delete(key);
      }
    }

    // Remove empty state if it was showing
    if (this.renderedOrder.length === 0 && this.listContainer.firstChild) {
      this.listContainer.innerHTML = "";
    }

    // Build/reorder rows — walk the desired order and ensure DOM matches
    let refNode: ChildNode | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const key = row.key;
      const signature = this.rowSignature(row);
      let el = this.rowElements.get(key);

      if (!el) {
        el = this.renderRow(row);
        this.rowElements.set(key, el);
        this.rowSignatures.set(key, signature);
        this.listContainer.insertBefore(el, refNode);
      } else {
        if (this.rowSignatures.get(key) !== signature) {
          const newEl = this.renderRow(row);
          this.listContainer.replaceChild(newEl, el);
          this.rowElements.set(key, newEl);
          this.rowSignatures.set(key, signature);
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
