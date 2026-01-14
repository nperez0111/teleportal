import type { DevtoolsMessage } from "../types";
import {
  formatMessagePayload,
  getMessageTypeLabel,
  getMessageTypeColor,
} from "../utils/message-utils";

export class MessageInspector {
  private element: HTMLElement;
  private message: DevtoolsMessage | null = null;
  private showAckDetails = false;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "devtools-inspector";
    this.render();
  }

  setMessage(message: DevtoolsMessage | null) {
    this.message = message;
    this.showAckDetails = false;
    this.render();
  }

  private copyToClipboard(text: string, button: HTMLElement) {
    navigator.clipboard.writeText(text).then(() => {
      button.classList.add("copied");
      const originalHTML = button.innerHTML;
      button.innerHTML = this.getCheckIcon();
      setTimeout(() => {
        button.classList.remove("copied");
        button.innerHTML = originalHTML;
      }, 1500);
    });
  }

  private getCopyIcon(): string {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  }

  private getCheckIcon(): string {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  }

  private render() {
    this.element.innerHTML = "";

    if (!this.message) {
      this.renderEmptyState();
      return;
    }

    this.renderHeader();
    this.renderContent();
  }

  private renderEmptyState() {
    const emptyState = document.createElement("div");
    emptyState.className = "devtools-inspector-empty";

    const icon = document.createElement("div");
    icon.className = "devtools-inspector-empty-icon";
    icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    emptyState.appendChild(icon);

    const text = document.createElement("div");
    text.className = "devtools-inspector-empty-text";
    text.textContent = "Select a message to inspect";
    emptyState.appendChild(text);

    this.element.appendChild(emptyState);
  }

  private renderHeader() {
    const payload = formatMessagePayload(this.message!.message);
    const header = document.createElement("div");
    header.className = "devtools-inspector-header";

    const title = document.createElement("div");
    title.className = "devtools-inspector-title";
    title.textContent = "Message Inspector";
    header.appendChild(title);

    if (payload) {
      const copyBtn = document.createElement("button");
      copyBtn.className = "devtools-inspector-copy-btn";
      copyBtn.innerHTML = `${this.getCopyIcon()} Copy`;
      copyBtn.addEventListener("click", () => {
        this.copyToClipboard(payload, copyBtn);
        copyBtn.innerHTML = `${this.getCheckIcon()} Copied`;
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.innerHTML = `${this.getCopyIcon()} Copy`;
          copyBtn.classList.remove("copied");
        }, 1500);
      });
      header.appendChild(copyBtn);
    }

    this.element.appendChild(header);
  }

  private renderContent() {
    const content = document.createElement("div");
    content.className = "devtools-inspector-content";

    // Metadata section
    content.appendChild(this.renderMetadataSection());

    // ACK section (if applicable)
    if (this.message!.ackedBy) {
      content.appendChild(this.renderAckSection());
    }

    // Payload section
    const payload = formatMessagePayload(this.message!.message);
    if (payload) {
      content.appendChild(this.renderPayloadSection(payload));
    }

    this.element.appendChild(content);
  }

  private renderMetadataSection(): HTMLElement {
    const section = document.createElement("div");
    section.className = "devtools-inspector-section";

    const titleContainer = document.createElement("div");
    titleContainer.className = "devtools-inspector-section-title";

    const icon = document.createElement("div");
    icon.className = "devtools-inspector-section-icon";
    icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    titleContainer.appendChild(icon);

    const title = document.createElement("span");
    title.textContent = "Details";
    titleContainer.appendChild(title);

    section.appendChild(titleContainer);

    const card = document.createElement("div");
    card.className = "devtools-inspector-card";

    // Message ID
    card.appendChild(
      this.createCopyableRow("Message ID", this.message!.id, true),
    );

    // Direction
    card.appendChild(this.createDirectionRow());

    // Type
    card.appendChild(this.createTypeRow());

    // Document
    card.appendChild(
      this.createCopyableRow(
        "Document",
        this.message!.document || "N/A",
        !!this.message!.document,
      ),
    );

    // Timestamp
    card.appendChild(
      this.createCopyableRow(
        "Timestamp",
        new Date(this.message!.timestamp).toISOString(),
        true,
      ),
    );

    // Encrypted
    card.appendChild(this.createEncryptedRow());

    section.appendChild(card);
    return section;
  }

  private createRow(label: string, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";
    valueEl.textContent = value;
    row.appendChild(valueEl);

    return row;
  }

  private createCopyableRow(
    label: string,
    value: string,
    copyable: boolean,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const valueContainer = document.createElement("div");
    valueContainer.className =
      "devtools-inspector-value devtools-inspector-value-copyable";

    const valueText = document.createElement("div");
    valueText.className =
      "devtools-inspector-value-text devtools-inspector-value-mono";
    valueText.textContent = value;
    valueContainer.appendChild(valueText);

    if (copyable && value !== "N/A") {
      const copyIcon = document.createElement("button");
      copyIcon.className = "devtools-inspector-copy-icon";
      copyIcon.innerHTML = this.getCopyIcon();
      copyIcon.title = "Copy to clipboard";
      copyIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        this.copyToClipboard(value, copyIcon);
      });
      valueContainer.appendChild(copyIcon);
    }

    row.appendChild(valueContainer);
    return row;
  }

  private createDirectionRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = "Direction";
    row.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";

    const badge = document.createElement("span");
    badge.className = `devtools-inspector-direction ${
      this.message!.direction === "sent"
        ? "devtools-inspector-direction-sent"
        : "devtools-inspector-direction-received"
    }`;

    const icon = document.createElement("span");
    icon.className = "devtools-inspector-direction-icon";
    icon.innerHTML =
      this.message!.direction === "sent"
        ? `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 9.5L9.5 2.5M9.5 2.5H4.5M9.5 2.5V7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M9.5 2.5L2.5 9.5M2.5 9.5H7.5M2.5 9.5V4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    badge.appendChild(icon);

    const text = document.createElement("span");
    text.textContent = this.message!.direction === "sent" ? "Sent" : "Received";
    badge.appendChild(text);

    valueEl.appendChild(badge);
    row.appendChild(valueEl);

    return row;
  }

  private createTypeRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = "Type";
    row.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";

    const badge = document.createElement("span");
    badge.className = `devtools-inspector-type ${getMessageTypeColor(this.message!.message)}`;
    badge.textContent = getMessageTypeLabel(this.message!.message);
    valueEl.appendChild(badge);

    row.appendChild(valueEl);
    return row;
  }

  private createEncryptedRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = "Encrypted";
    row.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";

    const encrypted = this.message!.message.encrypted;
    const indicator = document.createElement("span");
    indicator.className = `devtools-inspector-encrypted ${
      encrypted
        ? "devtools-inspector-encrypted-yes"
        : "devtools-inspector-encrypted-no"
    }`;

    if (encrypted) {
      indicator.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const text = document.createElement("span");
      text.textContent = "Yes";
      indicator.appendChild(text);
    } else {
      indicator.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
      const text = document.createElement("span");
      text.textContent = "No";
      indicator.appendChild(text);
    }

    valueEl.appendChild(indicator);
    row.appendChild(valueEl);
    return row;
  }

  private renderAckSection(): HTMLElement {
    const section = document.createElement("div");
    section.className = "devtools-inspector-section";

    const ackContainer = document.createElement("div");
    ackContainer.className = "devtools-inspector-ack-container";

    // Clickable header button
    const ackButton = document.createElement("button");
    ackButton.className = "devtools-inspector-ack-button";
    ackButton.addEventListener("click", () => {
      this.showAckDetails = !this.showAckDetails;
      this.render();
    });

    const icon = document.createElement("div");
    icon.className = "devtools-inspector-ack-icon";
    icon.textContent = "✓";
    ackButton.appendChild(icon);

    const label = document.createElement("span");
    label.className = "devtools-inspector-ack-label";
    label.textContent =
      this.message!.direction === "sent"
        ? "Acknowledged by server"
        : "Acknowledged by client";
    ackButton.appendChild(label);

    const chevron = document.createElement("span");
    chevron.className = "devtools-inspector-ack-chevron";
    chevron.innerHTML = this.showAckDetails
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    ackButton.appendChild(chevron);

    ackContainer.appendChild(ackButton);

    // Expandable details
    if (this.showAckDetails) {
      const details = document.createElement("div");
      details.className = "devtools-inspector-ack-details";

      // ACK Message ID (the ID of the ACK message itself)
      const ackMessageId = this.message!.ackedBy!.ackMessageId;
      details.appendChild(
        this.createAckDetailRow("ACK Message ID", ackMessageId),
      );

      // Acknowledged Message ID (the ID of the message that was acknowledged)
      const ackPayload = this.message!.ackedBy!.ackMessage.payload as {
        messageId: string;
      };
      details.appendChild(
        this.createAckDetailRow("Acknowledged ID", ackPayload.messageId),
      );

      ackContainer.appendChild(details);
    }

    section.appendChild(ackContainer);
    return section;
  }

  private createAckDetailRow(label: string, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-ack-detail-row";

    const labelEl = document.createElement("span");
    labelEl.className = "devtools-inspector-ack-detail-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const valueContainer = document.createElement("div");
    valueContainer.className = "devtools-inspector-ack-detail-value-container";

    const valueEl = document.createElement("span");
    valueEl.className = "devtools-inspector-ack-detail-value";
    valueEl.textContent = value;
    valueContainer.appendChild(valueEl);

    const copyIcon = document.createElement("button");
    copyIcon.className = "devtools-inspector-ack-copy-icon";
    copyIcon.innerHTML = this.getCopyIcon();
    copyIcon.title = "Copy to clipboard";
    copyIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      this.copyToClipboard(value, copyIcon);
    });
    valueContainer.appendChild(copyIcon);

    row.appendChild(valueContainer);
    return row;
  }

  private renderPayloadSection(payload: string): HTMLElement {
    const section = document.createElement("div");
    section.className = "devtools-inspector-section";

    const titleContainer = document.createElement("div");
    titleContainer.className = "devtools-inspector-section-title";

    const icon = document.createElement("div");
    icon.className = "devtools-inspector-section-icon";
    icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
    titleContainer.appendChild(icon);

    const title = document.createElement("span");
    title.textContent = "Payload";
    titleContainer.appendChild(title);

    section.appendChild(titleContainer);

    const payloadBox = document.createElement("div");
    payloadBox.className = "devtools-inspector-payload";

    const payloadContent = document.createElement("div");
    payloadContent.className = "devtools-inspector-payload-content";
    payloadContent.textContent = payload;

    payloadBox.appendChild(payloadContent);
    section.appendChild(payloadBox);

    return section;
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
