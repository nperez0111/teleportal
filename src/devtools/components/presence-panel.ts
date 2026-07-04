import type { PresenceFeedEntry, PresencePeer } from "../utils/presence-tracker";
import { formatRelativeTime } from "../utils/message-utils";

/** Stable, readable color per user for the roster dot. */
function peerColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

/**
 * Presence tab: live peer roster (from presence-join/leave/heartbeat) with
 * expandable per-peer data, plus a recent join/leave feed.
 */
export class PresencePanel {
  private element: HTMLElement;
  private listContainer: HTMLElement;
  private peers: PresencePeer[] = [];
  private feed: PresenceFeedEntry[] = [];
  private expandedPeers = new Set<string>();
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "devtools-flex devtools-flex-col devtools-h-full devtools-bg-white";

    const header = document.createElement("div");
    header.className = "devtools-list-header";
    const title = document.createElement("h2");
    title.className = "devtools-list-header-title";
    title.textContent = "Presence";
    header.append(title);
    this.element.append(header);

    this.listContainer = document.createElement("div");
    this.listContainer.className = "devtools-flex-1 devtools-overflow-y-auto";
    this.element.append(this.listContainer);

    this.refreshInterval = setInterval(() => {
      if (this.element.isConnected && (this.peers.length > 0 || this.feed.length > 0)) {
        this.render();
      }
    }, 1000);

    this.render();
  }

  update(peers: PresencePeer[], feed: PresenceFeedEntry[]) {
    this.peers = peers;
    this.feed = feed;
    this.render();
  }

  private render() {
    this.listContainer.innerHTML = "";

    if (this.peers.length === 0 && this.feed.length === 0) {
      const empty = document.createElement("div");
      empty.className = "devtools-p-4 devtools-text-center devtools-text-xs devtools-text-gray-500";
      empty.textContent = "No peers yet — presence-join messages will appear here";
      this.listContainer.append(empty);
      return;
    }

    for (const peer of this.peers) {
      this.listContainer.append(this.renderPeer(peer));
    }

    if (this.feed.length > 0) {
      const divider = document.createElement("div");
      divider.className = "devtools-presence-divider";
      divider.textContent = "recent";
      this.listContainer.append(divider);

      for (let i = this.feed.length - 1; i >= 0; i--) {
        this.listContainer.append(this.renderFeedEntry(this.feed[i]));
      }
    }
  }

  private renderPeer(peer: PresencePeer): HTMLElement {
    const item = document.createElement("div");
    item.className =
      "devtools-px-2 devtools-py-1.5 devtools-border-b devtools-border-gray-200 devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-transition-colors devtools-text-xs";
    item.addEventListener("click", () => {
      if (this.expandedPeers.has(peer.clientId)) {
        this.expandedPeers.delete(peer.clientId);
      } else {
        this.expandedPeers.add(peer.clientId);
      }
      this.render();
    });

    const row = document.createElement("div");
    row.className = "devtools-message-row";

    const dot = document.createElement("span");
    dot.className = "devtools-presence-dot";
    dot.style.background = peerColor(peer.userId);
    row.append(dot);

    const user = document.createElement("span");
    user.className = "devtools-presence-user";
    user.textContent = peer.userId;
    row.append(user);

    const client = document.createElement("span");
    client.className = "devtools-doc-meta";
    client.textContent = peer.clientId;
    client.title = "Server-assigned session/connection clientId";
    row.append(client);

    const awareness = document.createElement("span");
    awareness.className = "devtools-doc-meta";
    awareness.textContent = `awareness ${peer.awarenessId}`;
    awareness.title = "Y.js awareness clientID (equals the peer's Y.Doc clientID)";
    row.append(awareness);

    if (peer.document) {
      const docEl = document.createElement("span");
      docEl.className = "devtools-message-doc";
      docEl.textContent = peer.document;
      row.append(docEl);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "devtools-flex-1";
      row.append(spacer);
    }

    const joined = document.createElement("span");
    joined.className = "devtools-message-time";
    joined.textContent = `joined ${formatRelativeTime(peer.joinedAt)}`;
    row.append(joined);

    item.append(row);

    if (this.expandedPeers.has(peer.clientId)) {
      const dataBox = document.createElement("pre");
      dataBox.className = "devtools-presence-data";
      dataBox.textContent = JSON.stringify(peer.data, null, 2);
      item.append(dataBox);
    }

    return item;
  }

  private renderFeedEntry(entry: PresenceFeedEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "devtools-presence-feed-row";

    const arrow = document.createElement("span");
    arrow.className = `devtools-presence-feed-arrow ${
      entry.kind === "join" ? "devtools-text-green-600" : "devtools-text-red-600"
    }`;
    arrow.textContent = entry.kind === "join" ? "→" : "←";
    row.append(arrow);

    const text = document.createElement("span");
    text.className = "devtools-presence-feed-text";
    text.textContent = `${entry.userId} ${entry.kind === "join" ? "joined" : "left"}`;
    row.append(text);

    const client = document.createElement("span");
    client.className = "devtools-doc-meta";
    client.textContent = entry.clientId;
    row.append(client);

    const time = document.createElement("span");
    time.className = "devtools-message-time";
    time.textContent = formatRelativeTime(entry.timestamp);
    row.append(time);

    return row;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}
