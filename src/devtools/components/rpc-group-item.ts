import type { RpcGroup } from "../utils/rpc-tracker";
import { formatBytes, formatDuration, formatTimestamp } from "../utils/message-utils";
import { cloneSvg, ICON_CHEVRON_DOWN, ICON_CHEVRON_RIGHT, ICON_BOLT } from "../utils/svg-cache";

function createStatusPill(group: RpcGroup): HTMLElement {
  const pill = document.createElement("span");
  const transfer = group.transfer;

  switch (group.status) {
    case "pending": {
      pill.className = "devtools-status-pill devtools-status-pending";
      const spinner = document.createElement("span");
      spinner.className = "devtools-spinner";
      pill.append(spinner, "pending");
      break;
    }
    case "streaming": {
      pill.className = "devtools-status-pill devtools-status-streaming";
      const spinner = document.createElement("span");
      spinner.className = "devtools-spinner";
      pill.append(spinner, "streaming");
      break;
    }
    case "success": {
      pill.className = "devtools-status-pill devtools-status-success";
      pill.textContent =
        group.latencyMs !== undefined && !transfer
          ? `✓ ${formatDuration(group.latencyMs)}`
          : group.durationMs !== undefined
            ? `✓ ${formatDuration(group.durationMs)}`
            : "✓ done";
      break;
    }
    case "error": {
      pill.className = "devtools-status-pill devtools-status-error";
      pill.textContent = group.statusCode !== undefined ? `✕ ${group.statusCode}` : "✕ error";
      if (group.errorDetails) pill.title = group.errorDetails;
      break;
    }
  }
  return pill;
}

function createTransferProgress(group: RpcGroup): HTMLElement | null {
  const transfer = group.transfer;
  if (!transfer || transfer.totalChunks === undefined) return null;

  const done = transfer.direction === "upload" ? transfer.chunksAcked : transfer.chunksSeen;
  const total = transfer.totalChunks;

  const wrapper = document.createElement("div");
  wrapper.className = "devtools-progress-wrapper";
  wrapper.title = `${done}/${total} chunks${
    transfer.bytesTransferred > 0 ? ` · ${formatBytes(transfer.bytesTransferred)}` : ""
  }${transfer.size ? ` of ${formatBytes(transfer.size)}` : ""}`;

  const track = document.createElement("div");
  track.className = "devtools-progress-track";
  const fill = document.createElement("div");
  fill.className = `devtools-progress-fill${group.status === "error" ? " devtools-progress-fill-error" : ""}`;
  fill.style.width = `${total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0}%`;
  track.append(fill);

  const label = document.createElement("span");
  label.className = "devtools-progress-label";
  label.textContent = `${done}/${total}`;

  wrapper.append(track, label);
  return wrapper;
}

/**
 * A collapsed RPC call: request + streamed parts + response as one row.
 */
export function createRpcGroupItem(
  group: RpcGroup,
  isSelected: boolean,
  isExpanded: boolean,
  onClick: () => void,
  onToggle: () => void,
): HTMLElement {
  const item = document.createElement("div");
  item.className = `devtools-px-2 devtools-py-1.5 devtools-border-b devtools-border-gray-200 devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-transition-colors devtools-text-xs ${
    isSelected ? "devtools-bg-blue-50" : ""
  }`;
  item.addEventListener("click", onClick);

  const container = document.createElement("div");
  container.className = "devtools-message-row";

  // Expand/collapse chevron
  const memberCount = (group.request ? 1 : 0) + group.parts.length + (group.response ? 1 : 0);
  const chevron = document.createElement("button");
  chevron.className = "devtools-group-chevron";
  chevron.title = isExpanded ? "Collapse call" : `Expand call (${memberCount} messages)`;
  chevron.append(cloneSvg(isExpanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT));
  chevron.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });
  container.append(chevron);

  // Method badge (bolt marks it as an RPC call)
  const badge = document.createElement("div");
  badge.className = "devtools-type-badge devtools-rpc-group-badge devtools-bg-indigo-600";
  const bolt = document.createElement("span");
  bolt.className = "devtools-rpc-bolt";
  bolt.append(cloneSvg(ICON_BOLT));
  badge.append(bolt, group.method);
  container.append(badge);

  container.append(createStatusPill(group));

  const progress = createTransferProgress(group);
  if (progress) container.append(progress);

  // Part count for non-transfer streaming calls
  if (!progress && group.parts.length > 0) {
    const parts = document.createElement("span");
    parts.className = "devtools-group-parts";
    parts.textContent = `${group.parts.length} part${group.parts.length === 1 ? "" : "s"}`;
    container.append(parts);
  }

  // Document name
  const docEl = document.createElement("div");
  docEl.className = "devtools-message-doc";
  if (group.document) docEl.textContent = group.document;
  container.append(docEl);

  // Timestamp of the call start (or first visible member)
  const timestampEl = document.createElement("div");
  timestampEl.className = "devtools-message-time";
  const anchor = group.request ?? group.parts[0] ?? group.response;
  if (anchor) timestampEl.textContent = formatTimestamp(anchor.timestamp);
  container.append(timestampEl);

  item.append(container);
  return item;
}
