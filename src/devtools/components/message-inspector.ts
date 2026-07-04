import type { VersionedUpdate } from "teleportal";
import type { DevtoolsMessage } from "../types";
import type { RpcGroup } from "../utils/rpc-tracker";
import {
  decryptContentPayload,
  formatBytes,
  formatDuration,
  formatLogEntry,
  formatMessagePayload,
  formatEncryptedDocEnvelope,
  formatEncryptedAwarenessEnvelope,
  getAckLatencyLevel,
  getMessageTypeLabel,
  getMessageTypeColor,
} from "../utils/message-utils";
import { decodeUpdateOps, formatUpdateOp, type DecodedUpdateOps } from "../utils/update-decoder";
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
  private group: RpcGroup | null = null;
  private showAckDetails = false;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "devtools-inspector";
    this.render();
  }

  setMessage(message: DevtoolsMessage | null) {
    this.message = message;
    this.group = null;
    this.showAckDetails = false;
    this.render();
  }

  setGroup(group: RpcGroup | null) {
    this.group = group;
    this.message = null;
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

    if (this.group) {
      this.renderGroupHeader();
      this.renderGroupContent();
      return;
    }

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

    this.appendOpsSection(content);

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

    const ackLatency = Math.max(0, this.message!.ackedBy!.timestamp - this.message!.timestamp);
    const latencyBadge = document.createElement("span");
    latencyBadge.className = `devtools-ack-indicator devtools-ack-${getAckLatencyLevel(ackLatency)}`;
    latencyBadge.textContent = formatDuration(ackLatency);
    latencyBadge.title = `Round-trip until acknowledgement: ${ackLatency}ms`;
    ackButton.append(latencyBadge);

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

  // --- Update operations (human-readable diff) ---

  private async getUpdateOps(): Promise<DecodedUpdateOps | null> {
    const devtoolsMessage = this.message;
    if (!devtoolsMessage) return null;
    const msg = devtoolsMessage.message;
    if (msg.type !== "doc") return null;
    const payload = msg.payload;
    if (payload.type !== "update" && payload.type !== "sync-step-2") return null;

    let update = payload.update as VersionedUpdate;
    if (msg.encrypted) {
      const key = devtoolsMessage.provider.encryptionKey;
      if (!key) return null;
      const decrypted = await decryptContentPayload(update.data as Uint8Array, key);
      if (!decrypted) return null;
      update = decrypted.update as unknown as VersionedUpdate;
    }

    try {
      return decodeUpdateOps(update);
    } catch {
      return null;
    }
  }

  private appendOpsSection(content: HTMLElement) {
    const selected = this.message;
    this.getUpdateOps().then((decoded) => {
      // Bail if the selection changed while decoding.
      if (!decoded || decoded.ops.length === 0 || this.message !== selected) return;

      const section = document.createElement("div");
      section.className = "devtools-inspector-section";

      const titleContainer = document.createElement("div");
      titleContainer.className = "devtools-inspector-section-title";
      const icon = document.createElement("div");
      icon.className = "devtools-inspector-section-icon";
      icon.append(cloneSvg(ICON_PAYLOAD));
      titleContainer.append(icon);
      const title = document.createElement("span");
      title.textContent = `Operations (${decoded.ops.length})`;
      titleContainer.append(title);
      section.append(titleContainer);

      const box = document.createElement("div");
      box.className = "devtools-ops-box";

      const summaryParts: string[] = [];
      if (decoded.insertCount > 0) {
        summaryParts.push(`${decoded.insertCount} inserts (${decoded.insertedLength} items)`);
      }
      if (decoded.deleteCount > 0) {
        summaryParts.push(`${decoded.deleteCount} deletes (${decoded.deletedLength} items)`);
      }
      if (summaryParts.length > 0) {
        const summary = document.createElement("div");
        summary.className = "devtools-ops-summary";
        summary.textContent = summaryParts.join(" · ");
        box.append(summary);
      }

      for (const op of decoded.ops) {
        const line = document.createElement("div");
        line.className = `devtools-op-line devtools-op-${op.kind}`;
        line.textContent = formatUpdateOp(op);
        box.append(line);
      }

      section.append(box);

      // Insert before the payload sections so the readable diff comes first.
      const firstPayloadSection = content.querySelector(
        ":scope > .devtools-inspector-section .devtools-inspector-payload",
      )?.parentElement;
      if (firstPayloadSection) {
        content.insertBefore(section, firstPayloadSection);
      } else {
        content.append(section);
      }
    });
  }

  // --- RPC group (call) view ---

  private renderGroupHeader() {
    const group = this.group!;
    const header = document.createElement("div");
    header.className = "devtools-inspector-header";

    const title = document.createElement("div");
    title.className = "devtools-inspector-title";
    title.textContent = "RPC Call";
    header.append(title);

    const btnGroup = document.createElement("div");
    btnGroup.className = "devtools-inspector-btn-group";

    const logBtn = document.createElement("button");
    logBtn.className = "devtools-inspector-copy-btn";
    logBtn.append(cloneSvg(ICON_COPY), " Copy Log");
    logBtn.title = "Copy a log transcript of the request, parts, and response";
    logBtn.addEventListener("click", () => {
      const members: DevtoolsMessage[] = [];
      if (group.request) members.push(group.request);
      members.push(...group.parts);
      if (group.response) members.push(group.response);
      const log = members.map((m) => formatLogEntry(m)).join("\n");
      navigator.clipboard.writeText(log).then(() => {
        logBtn.replaceChildren(cloneSvg(ICON_CHECK), " Copied");
        logBtn.classList.add("copied");
        setTimeout(() => {
          logBtn.replaceChildren(cloneSvg(ICON_COPY), " Copy Log");
          logBtn.classList.remove("copied");
        }, 1500);
      });
    });
    btnGroup.append(logBtn);

    header.append(btnGroup);
    this.element.append(header);
  }

  private renderGroupContent() {
    const group = this.group!;
    const content = document.createElement("div");
    content.className = "devtools-inspector-content";

    content.append(this.renderGroupMetadataSection());

    if (group.status === "error" && group.errorDetails) {
      content.append(this.renderGroupErrorSection());
    }

    if (group.transfer) {
      content.append(this.renderTransferSection());
    }

    const provider = (group.request ?? group.response ?? group.parts[0])?.provider;
    if (group.request && provider) {
      content.append(
        this.renderPayloadSection(
          formatMessagePayload(group.request.message, provider),
          "Request Payload",
        ),
      );
    }
    if (group.response && provider) {
      content.append(
        this.renderPayloadSection(
          formatMessagePayload(group.response.message, provider),
          "Response Payload",
        ),
      );
    }

    this.element.append(content);
  }

  private renderGroupMetadataSection(): HTMLElement {
    const group = this.group!;
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

    card.append(this.createCopyableRow("Method", group.method, true));
    card.append(this.createGroupStatusRow());
    if (group.latencyMs !== undefined) {
      card.append(this.createRow("Latency", formatDuration(group.latencyMs)));
    }
    if (
      group.durationMs !== undefined &&
      group.parts.length > 0 &&
      group.durationMs !== group.latencyMs
    ) {
      card.append(this.createRow("Duration", formatDuration(group.durationMs)));
    }
    card.append(this.createCopyableRow("Document", group.document || "N/A", !!group.document));
    card.append(
      this.createCopyableRow("Request ID", group.request ? group.key : "N/A", !!group.request),
    );

    const memberCount = (group.request ? 1 : 0) + group.parts.length + (group.response ? 1 : 0);
    const partsSummary =
      group.parts.length > 0 ? `${memberCount} (${group.parts.length} parts)` : `${memberCount}`;
    card.append(this.createRow("Messages", partsSummary));

    section.append(card);
    return section;
  }

  private createGroupStatusRow(): HTMLElement {
    const group = this.group!;
    const row = document.createElement("div");
    row.className = "devtools-inspector-row";

    const labelEl = document.createElement("div");
    labelEl.className = "devtools-inspector-label";
    labelEl.textContent = "Status";
    row.append(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "devtools-inspector-value";

    const pill = document.createElement("span");
    pill.className = `devtools-status-pill devtools-status-${group.status}`;
    switch (group.status) {
      case "pending":
        pill.textContent = "pending";
        break;
      case "streaming":
        pill.textContent = "streaming";
        break;
      case "success":
        pill.textContent = "✓ success";
        break;
      case "error":
        pill.textContent = group.statusCode !== undefined ? `✕ ${group.statusCode}` : "✕ error";
        break;
    }
    valueEl.append(pill);
    row.append(valueEl);
    return row;
  }

  private renderGroupErrorSection(): HTMLElement {
    const group = this.group!;
    const section = document.createElement("div");
    section.className = "devtools-inspector-section";

    const box = document.createElement("div");
    box.className = "devtools-inspector-error-box";
    box.textContent = group.errorDetails ?? "Unknown error";
    section.append(box);
    return section;
  }

  private renderTransferSection(): HTMLElement {
    const group = this.group!;
    const transfer = group.transfer!;
    const section = document.createElement("div");
    section.className = "devtools-inspector-section";

    const titleContainer = document.createElement("div");
    titleContainer.className = "devtools-inspector-section-title";
    const icon = document.createElement("div");
    icon.className = "devtools-inspector-section-icon";
    icon.append(cloneSvg(ICON_PAYLOAD));
    titleContainer.append(icon);
    const title = document.createElement("span");
    title.textContent = transfer.direction === "upload" ? "File Upload" : "File Download";
    titleContainer.append(title);
    section.append(titleContainer);

    const card = document.createElement("div");
    card.className = "devtools-inspector-card";

    // Progress bar spanning the card
    if (transfer.totalChunks !== undefined) {
      const done = transfer.direction === "upload" ? transfer.chunksAcked : transfer.chunksSeen;
      const percent =
        transfer.totalChunks > 0
          ? Math.min(100, Math.round((done / transfer.totalChunks) * 100))
          : 0;

      const progressRow = document.createElement("div");
      progressRow.className = "devtools-inspector-progress-row";

      const track = document.createElement("div");
      track.className = "devtools-progress-track devtools-progress-track-lg";
      const fill = document.createElement("div");
      fill.className = `devtools-progress-fill${group.status === "error" ? " devtools-progress-fill-error" : ""}`;
      fill.style.width = `${percent}%`;
      track.append(fill);
      progressRow.append(track);

      const label = document.createElement("span");
      label.className = "devtools-progress-label";
      label.textContent = `${percent}%`;
      progressRow.append(label);

      card.append(progressRow);
    }

    if (transfer.filename) {
      card.append(this.createCopyableRow("Filename", transfer.filename, true));
    }
    if (transfer.fileId) {
      card.append(this.createCopyableRow("File ID", transfer.fileId, true));
    }
    if (transfer.size !== undefined) {
      card.append(this.createRow("Size", formatBytes(transfer.size)));
    }
    if (transfer.mimeType) {
      card.append(this.createRow("MIME Type", transfer.mimeType));
    }
    const chunksText =
      transfer.totalChunks !== undefined
        ? transfer.direction === "upload"
          ? `${transfer.chunksAcked} acked / ${transfer.chunksSeen} sent / ${transfer.totalChunks} total`
          : `${transfer.chunksSeen} received / ${transfer.totalChunks} total`
        : `${transfer.chunksSeen} seen`;
    card.append(this.createRow("Chunks", chunksText));
    if (transfer.bytesTransferred > 0) {
      card.append(this.createRow("Transferred", formatBytes(transfer.bytesTransferred)));
    }
    card.append(this.createRow("Encrypted", transfer.encrypted ? "Yes" : "No"));

    section.append(card);
    return section;
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
