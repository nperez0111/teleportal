import type { DevtoolsMessage } from "../types";
import { formatMessagePayload, formatTimestamp } from "../utils/message-utils";

export class MessageInspector {
  private element: HTMLElement;
  private message: DevtoolsMessage | null = null;
  private showAckDetails = false;
  private copied = false;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "devtools-h-full devtools-flex devtools-flex-col devtools-bg-white";
    this.render();
  }

  setMessage(message: DevtoolsMessage | null) {
    this.message = message;
    this.showAckDetails = false;
    this.render();
  }

  private render() {
    this.element.innerHTML = "";

    if (!this.message) {
      const emptyState = document.createElement("div");
      emptyState.className =
        "devtools-h-full devtools-bg-white devtools-flex devtools-items-center devtools-justify-center";
      const text = document.createElement("div");
      text.className = "devtools-text-gray-500";
      text.textContent = "Select a message to inspect";
      emptyState.appendChild(text);
      this.element.appendChild(emptyState);
      return;
    }

    const payload = formatMessagePayload(this.message.message);

    // Header
    const header = document.createElement("div");
    header.className =
      "devtools-px-2 devtools-py-1 devtools-border-b devtools-border-gray-200 devtools-bg-gray-50";
    const headerContent = document.createElement("div");
    headerContent.className = "devtools-flex devtools-items-center devtools-justify-between";
    const title = document.createElement("h2");
    title.className = "devtools-text-sm devtools-font-semibold devtools-text-gray-900";
    title.textContent = "Inspector";
    headerContent.appendChild(title);

    if (payload) {
      const copyButton = document.createElement("button");
      copyButton.className =
        "devtools-px-2 devtools-py-0.5 devtools-text-xs devtools-button-primary devtools-rounded devtools-transition-colors";
      copyButton.textContent = this.copied ? "Copied" : "Copy";
      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(payload);
          this.copied = true;
          copyButton.textContent = "Copied";
          setTimeout(() => {
            this.copied = false;
            copyButton.textContent = "Copy";
          }, 2000);
        } catch (error) {
          console.error("Failed to copy:", error);
        }
      });
      headerContent.appendChild(copyButton);
    }

    header.appendChild(headerContent);
    this.element.appendChild(header);

    // Content
    const content = document.createElement("div");
    content.className =
      "devtools-flex-1 devtools-overflow-y-auto devtools-p-2 devtools-space-y-2";

    // Metadata section
    const metadataSection = document.createElement("div");
    const metadataTitle = document.createElement("h3");
    metadataTitle.className =
      "devtools-text-xs devtools-font-semibold devtools-text-gray-700 devtools-mb-1";
    metadataTitle.textContent = "Metadata";
    metadataSection.appendChild(metadataTitle);

    const metadataContent = document.createElement("div");
    metadataContent.className =
      "devtools-bg-gray-50 devtools-p-1.5 devtools-rounded devtools-space-y-1.5 devtools-text-xs";

    // ID
    const idRow = document.createElement("div");
    const idLabel = document.createElement("span");
    idLabel.className = "devtools-text-gray-600";
    idLabel.textContent = "ID:";
    idRow.appendChild(idLabel);
    const idValue = document.createElement("div");
    idValue.className =
      "devtools-font-mono devtools-text-gray-900 devtools-break-all devtools-mt-0.5";
    idValue.textContent = this.message.id;
    idRow.appendChild(idValue);
    metadataContent.appendChild(idRow);

    // Direction
    const directionRow = document.createElement("div");
    directionRow.className = "devtools-flex devtools-justify-between";
    const directionLabel = document.createElement("span");
    directionLabel.className = "devtools-text-gray-600";
    directionLabel.textContent = "Direction:";
    directionRow.appendChild(directionLabel);
    const directionValue = document.createElement("span");
    directionValue.className = "devtools-text-gray-900";
    directionValue.textContent = this.message.direction;
    directionRow.appendChild(directionValue);
    metadataContent.appendChild(directionRow);

    // Document
    const docRow = document.createElement("div");
    const docLabel = document.createElement("span");
    docLabel.className = "devtools-text-gray-600";
    docLabel.textContent = "Document:";
    docRow.appendChild(docLabel);
    const docValue = document.createElement("div");
    docValue.className =
      "devtools-font-mono devtools-text-gray-900 devtools-break-all devtools-mt-0.5";
    docValue.textContent = this.message.document || "N/A";
    docRow.appendChild(docValue);
    metadataContent.appendChild(docRow);

    // Timestamp
    const timestampRow = document.createElement("div");
    timestampRow.className = "devtools-flex devtools-justify-between";
    const timestampLabel = document.createElement("span");
    timestampLabel.className = "devtools-text-gray-600";
    timestampLabel.textContent = "Timestamp:";
    timestampRow.appendChild(timestampLabel);
    const timestampValue = document.createElement("span");
    timestampValue.className = "devtools-text-gray-900";
    timestampValue.textContent = formatTimestamp(this.message.timestamp);
    timestampRow.appendChild(timestampValue);
    metadataContent.appendChild(timestampRow);

    // Encrypted
    const encryptedRow = document.createElement("div");
    encryptedRow.className = "devtools-flex devtools-justify-between";
    const encryptedLabel = document.createElement("span");
    encryptedLabel.className = "devtools-text-gray-600";
    encryptedLabel.textContent = "Encrypted:";
    encryptedRow.appendChild(encryptedLabel);
    const encryptedValue = document.createElement("span");
    encryptedValue.className = "devtools-text-gray-900";
    encryptedValue.textContent = this.message.message.encrypted ? "✅" : "❌";
    encryptedRow.appendChild(encryptedValue);
    metadataContent.appendChild(encryptedRow);

    // Type
    const typeRow = document.createElement("div");
    typeRow.className = "devtools-flex devtools-justify-between";
    const typeLabel = document.createElement("span");
    typeLabel.className = "devtools-text-gray-600";
    typeLabel.textContent = "Type:";
    typeRow.appendChild(typeLabel);
    const typeValue = document.createElement("span");
    typeValue.className = "devtools-font-mono devtools-text-gray-900";
    typeValue.textContent = this.message.message.type;
    typeRow.appendChild(typeValue);
    metadataContent.appendChild(typeRow);

    // ACK'd by
    if (this.message.ackedBy) {
      const ackRow = document.createElement("div");
      const ackHeader = document.createElement("div");
      ackHeader.className = "devtools-flex devtools-items-center devtools-gap-1 devtools-mb-0.5";
      const ackLabel = document.createElement("span");
      ackLabel.className = "devtools-text-gray-600";
      ackLabel.textContent = "ACK'd by:";
      ackHeader.appendChild(ackLabel);
      const ackToggle = document.createElement("button");
      ackToggle.className =
        "devtools-text-xs devtools-text-blue-600 devtools-hover:underline devtools-px-1";
      ackToggle.textContent = this.showAckDetails ? "▼" : "▶";
      ackToggle.addEventListener("click", () => {
        this.showAckDetails = !this.showAckDetails;
        this.render();
      });
      ackHeader.appendChild(ackToggle);
      ackRow.appendChild(ackHeader);
      const ackValue = document.createElement("div");
      ackValue.className =
        "devtools-font-mono devtools-text-green-600 devtools-break-all";
      ackValue.textContent = this.message.ackedBy.ackMessageId;
      ackRow.appendChild(ackValue);
      metadataContent.appendChild(ackRow);
    }

    metadataSection.appendChild(metadataContent);
    content.appendChild(metadataSection);

    // ACK Message details
    if (this.message.ackedBy && this.showAckDetails) {
      const ackSection = document.createElement("div");
      const ackTitle = document.createElement("h3");
      ackTitle.className =
        "devtools-text-xs devtools-font-semibold devtools-text-gray-700 devtools-mb-1";
      ackTitle.textContent = "ACK Message";
      ackSection.appendChild(ackTitle);
      const ackPre = document.createElement("pre");
      ackPre.className =
        "devtools-bg-gray-50 devtools-p-1.5 devtools-rounded devtools-overflow-x-auto devtools-text-xs devtools-font-mono devtools-text-gray-900 devtools-border devtools-border-gray-200 devtools-max-h-32 devtools-overflow-y-auto";
      ackPre.textContent = JSON.stringify(
        this.message.ackedBy.ackMessage.toJSON(),
        null,
        2,
      );
      ackSection.appendChild(ackPre);
      content.appendChild(ackSection);
    }

    // Payload section
    if (payload) {
      const payloadSection = document.createElement("div");
      const payloadTitle = document.createElement("h3");
      payloadTitle.className =
        "devtools-text-xs devtools-font-semibold devtools-text-gray-700 devtools-mb-1";
      payloadTitle.textContent = "Payload";
      payloadSection.appendChild(payloadTitle);
      const payloadPre = document.createElement("pre");
      payloadPre.className =
        "devtools-bg-gray-50 devtools-p-1.5 devtools-rounded devtools-overflow-x-auto devtools-text-xs devtools-font-mono devtools-text-gray-900 devtools-border devtools-border-gray-200 devtools-max-h-[60vh] devtools-overflow-y-auto";
      payloadPre.textContent = payload;
      payloadSection.appendChild(payloadPre);
      content.appendChild(payloadSection);
    }

    this.element.appendChild(content);
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
