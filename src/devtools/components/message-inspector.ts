import type { DevtoolsMessage } from "../types";
import {
  formatLogEntry,
  formatMessagePayload,
  formatEncryptedDocEnvelope,
  formatEncryptedAwarenessEnvelope,
  getMessageTypeLabel,
  getMessageTypeColor,
} from "../utils/message-utils";
import {
  cloneSvg,
  ICON_COPY,
  ICON_CHECK,
  ICON_MESSAGE,
  ICON_INFO,
  ICON_LOCK_OPEN,
  ICON_LOCK_CLOSED,
  ICON_PAYLOAD,
  ICON_CHEVRON_UP,
  ICON_CHEVRON_DOWN,
  ICON_ARROW_SENT_SM,
  ICON_ARROW_RECEIVED_SM,
} from "../utils/svg-cache";

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
      button.replaceChildren(cloneSvg(ICON_CHECK));
      setTimeout(() => {
        button.classList.remove("copied");
        button.replaceChildren(cloneSvg(ICON_COPY));
      }, 1500);
    });
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
    icon.append(cloneSvg(ICON_MESSAGE));
    emptyState.append(icon);

    const text = document.createElement("div");
    text.className = "devtools-inspector-empty-text";
    text.textContent = "Select a message to inspect";
    emptyState.append(text);

    this.element.append(emptyState);
  }

  private renderHeader() {
    if (!this.message) return;
    const payload = formatMessagePayload(this.message.message, this.message.provider);
    const header = document.createElement("div");
    header.className = "devtools-inspector-header";

    const title = document.createElement("div");
    title.className = "devtools-inspector-title";
    title.textContent = "Message Inspector";
    header.append(title);

    const btnGroup = document.createElement("div");
    btnGroup.className = "devtools-inspector-btn-group";

    const logBtn = document.createElement("button");
    logBtn.className = "devtools-inspector-copy-btn";
    logBtn.append(cloneSvg(ICON_COPY), " Copy Log");
    logBtn.title = "Copy a one-line log entry (direction, type, doc, timing) for sharing";
    logBtn.addEventListener("click", () => {
      const entry = formatLogEntry(this.message!);
      navigator.clipboard.writeText(entry).then(() => {
        logBtn.replaceChildren(cloneSvg(ICON_CHECK), " Copied");
        logBtn.classList.add("copied");
        setTimeout(() => {
          logBtn.replaceChildren(cloneSvg(ICON_COPY), " Copy Log");
          logBtn.classList.remove("copied");
        }, 1500);
      });
    });
    btnGroup.append(logBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "devtools-inspector-copy-btn";
    copyBtn.append(cloneSvg(ICON_COPY), " Copy Payload");
    copyBtn.title = "Copy the decoded payload JSON";

    payload.then((res) => {
      if (!res) {
        return;
      }

      btnGroup.append(copyBtn);
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(res).then(() => {
          copyBtn.replaceChildren(cloneSvg(ICON_CHECK), " Copied");
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.replaceChildren(cloneSvg(ICON_COPY), " Copy Payload");
            copyBtn.classList.remove("copied");
          }, 1500);
        });
      });
    });

    header.append(btnGroup);
    this.element.append(header);
  }

  private renderContent() {
    if (!this.message) return;
    const content = document.createElement("div");
    content.className = "devtools-inspector-content";

    content.append(this.renderMetadataSection());

    if (this.message.ackedBy) {
      content.append(this.renderAckSection());
    }

    const msg = this.message.message;
    if (msg.encrypted) {
      const hasKey = !!this.message.provider.encryptionKey;
      const decrypted = formatMessagePayload(msg, this.message.provider);
      content.append(
        this.renderPayloadSection(
          decrypted,
          hasKey ? "Decrypted Payload" : "Raw Payload",
          hasKey ? ICON_LOCK_OPEN : undefined,
        ),
      );

      const envelope = this.getEncryptedEnvelopePayload();
      if (envelope) {
        content.append(
          this.renderPayloadSection(
            Promise.resolve(envelope),
            "Encrypted Envelope",
            ICON_LOCK_CLOSED,
          ),
        );
      }
    } else {
      const payload = formatMessagePayload(msg, this.message.provider);
      if (payload) {
        content.append(this.renderPayloadSection(payload));
      }
    }

    this.element.append(content);
  }

  private getEncryptedEnvelopePayload(): string | null {
    if (!this.message?.message.encrypted) return null;

    const msg = this.message.message;
    if (msg.type === "doc") {
      const payloadType = msg.payload.type;
      if (payloadType === "update" || payloadType === "sync-step-2") {
        return formatEncryptedDocEnvelope(msg.payload.update.data as Uint8Array);
      }
    }
    if (msg.type === "awareness" && msg.payload.type === "awareness-update") {
      return formatEncryptedAwarenessEnvelope(msg.payload.update);
    }
    return null;
  }

  private renderMetadataSection(): HTMLElement {
    const section = document.createElement("div");
    section.className = "devtools-inspector-section";

    const titleContainer = document.createElement("div");
    titleContainer.className = "devtools-inspector-section-title";

    const icon = document.createElement("div");
    icon.className = "devtools-inspector-section-icon";
    icon.append(cloneSvg(ICON_INFO));
    titleContainer.append(icon);

    const title = document.createElement("span");
    title.textContent = "Details";
    titleContainer.append(title);

    section.append(titleContainer);

    const card = document.createElement("div");
    card.className = "devtools-inspector-card";

    // Message ID
    card.append(this.createCopyableRow("Message ID", this.message!.id, true));

    // Direction
    card.append(this.createDirectionRow());

    // Type
    card.append(this.createTypeRow());

    // Document
    card.append(
      this.createCopyableRow("Document", this.message!.document || "N/A", !!this.message!.document),
    );

    // Size
    card.append(this.createRow("Size", `${this.message!.message.encoded.byteLength}`));

    // Timestamp
    card.append(
      this.createCopyableRow("Timestamp", new Date(this.message!.timestamp).toISOString(), true),
    );

    // Encrypted
    card.append(this.createEncryptedRow());

    section.append(card);
    return section;
  }

  private createRow(label: string, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = label;
    row.append(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";
    valueEl.textContent = value;
    row.append(valueEl);

    return row;
  }

  private createCopyableRow(label: string, value: string, copyable: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = label;
    row.append(labelEl);

    const valueContainer = document.createElement("div");
    valueContainer.className = "devtools-inspector-value devtools-inspector-value-copyable";

    const valueText = document.createElement("div");
    valueText.className = "devtools-inspector-value-text devtools-inspector-value-mono";
    valueText.textContent = value;
    valueContainer.append(valueText);

    if (copyable && value !== "N/A") {
      const copyIcon = document.createElement("button");
      copyIcon.className = "devtools-inspector-copy-icon";
      copyIcon.append(cloneSvg(ICON_COPY));
      copyIcon.title = "Copy to clipboard";
      copyIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        this.copyToClipboard(value, copyIcon);
      });
      valueContainer.append(copyIcon);
    }

    row.append(valueContainer);
    return row;
  }

  private createDirectionRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = "Direction";
    row.append(labelEl);

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
    icon.append(
      cloneSvg(this.message!.direction === "sent" ? ICON_ARROW_SENT_SM : ICON_ARROW_RECEIVED_SM),
    );
    badge.append(icon);

    const text = document.createElement("span");
    text.textContent = this.message!.direction === "sent" ? "Sent" : "Received";
    badge.append(text);

    valueEl.append(badge);
    row.append(valueEl);

    return row;
  }

  private createTypeRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = "Type";
    row.append(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";

    const badge = document.createElement("span");
    badge.className = `devtools-inspector-type ${getMessageTypeColor(this.message!.message)}`;
    badge.textContent = getMessageTypeLabel(this.message!.message);
    valueEl.append(badge);

    row.append(valueEl);
    return row;
  }

  private createEncryptedRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = "Encrypted";
    row.append(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";

    const encrypted = this.message!.message.encrypted;
    const indicator = document.createElement("span");
    indicator.className = `devtools-inspector-encrypted ${
      encrypted ? "devtools-inspector-encrypted-yes" : "devtools-inspector-encrypted-no"
    }`;

    indicator.append(cloneSvg(encrypted ? ICON_LOCK_CLOSED : ICON_LOCK_OPEN));
    const text = document.createElement("span");
    text.textContent = encrypted ? "Yes" : "No";
    indicator.append(text);

    valueEl.append(indicator);
    row.append(valueEl);
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
    ackButton.append(icon);

    const label = document.createElement("span");
    label.className = "devtools-inspector-ack-label";
    label.textContent =
      this.message!.direction === "sent" ? "Acknowledged by server" : "Acknowledged by client";
    ackButton.append(label);

    const chevron = document.createElement("span");
    chevron.className = "devtools-inspector-ack-chevron";
    chevron.append(cloneSvg(this.showAckDetails ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN));
    ackButton.append(chevron);

    ackContainer.append(ackButton);

    // Expandable details
    if (this.showAckDetails) {
      const details = document.createElement("div");
      details.className = "devtools-inspector-ack-details";

      // ACK Message ID (the ID of the ACK message itself)
      const ackMessageId = this.message!.ackedBy!.ackMessageId;
      details.append(this.createAckDetailRow("ACK Message ID", ackMessageId));

      // Acknowledged Message ID (the ID of the message that was acknowledged)
      const ackPayload = this.message!.ackedBy!.ackMessage.payload as {
        messageId: string;
      };
      details.append(this.createAckDetailRow("Acknowledged ID", ackPayload.messageId));

      ackContainer.append(details);
    }

    section.append(ackContainer);
    return section;
  }

  private createAckDetailRow(label: string, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-inspector-ack-detail-row";

    const labelEl = document.createElement("span");
    labelEl.className = "devtools-inspector-ack-detail-label";
    labelEl.textContent = label;
    row.append(labelEl);

    const valueContainer = document.createElement("div");
    valueContainer.className = "devtools-inspector-ack-detail-value-container";

    const valueEl = document.createElement("span");
    valueEl.className = "devtools-inspector-ack-detail-value";
    valueEl.textContent = value;
    valueContainer.append(valueEl);

    const copyIcon = document.createElement("button");
    copyIcon.className = "devtools-inspector-ack-copy-icon";
    copyIcon.append(cloneSvg(ICON_COPY));
    copyIcon.title = "Copy to clipboard";
    copyIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      this.copyToClipboard(value, copyIcon);
    });
    valueContainer.append(copyIcon);

    row.append(valueContainer);
    return row;
  }

  private renderPayloadSection(
    payload: Promise<string | null>,
    sectionTitle = "Payload",
    iconSvg?: string,
  ): HTMLElement {
    const section = document.createElement("div");
    section.className = "devtools-inspector-section";

    const titleContainer = document.createElement("div");
    titleContainer.className = "devtools-inspector-section-title";

    const icon = document.createElement("div");
    icon.className = "devtools-inspector-section-icon";
    icon.append(cloneSvg(iconSvg ?? ICON_PAYLOAD));
    titleContainer.append(icon);

    const title = document.createElement("span");
    title.textContent = sectionTitle;
    titleContainer.append(title);

    section.append(titleContainer);

    const payloadBox = document.createElement("div");
    payloadBox.className = "devtools-inspector-payload";

    const payloadContent = document.createElement("div");
    payloadContent.className = "devtools-inspector-payload-content";
    payload.then((res) => {
      payloadContent.textContent = res;
    });

    payloadBox.append(payloadContent);
    section.append(payloadBox);

    return section;
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
