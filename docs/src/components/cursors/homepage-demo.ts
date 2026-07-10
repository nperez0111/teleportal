import type { Provider } from "teleportal/providers";
import { createTeleportalDevtools, getDevtoolsState } from "teleportal/devtools";
import type { Awareness } from "y-protocols/awareness";
import type { Identity } from "./identity";
import type { BoopRpc } from "../../../../examples/awareness/src/boop-client";

interface PeerInfo {
  awarenessId: number;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
}

export class HomepageDemo {
  #container: HTMLElement;
  #canvas: HTMLElement;
  #userListEl: HTMLElement;
  #countEl: HTMLElement;
  #boopCountEl: HTMLElement;
  #toggleBtn: HTMLElement;
  #toggleDot: HTMLElement;
  #toggleLabel: HTMLElement;
  #devtoolsContainer: HTMLElement;
  #devtoolsMounted = false;
  #devtoolsOpen = false;
  #provider: Provider;
  #identity: Identity;
  #boopCount = 0;
  #connected = true;

  constructor(target: HTMLElement, provider: Provider, identity: Identity) {
    this.#provider = provider;
    this.#identity = identity;

    this.#container = document.createElement("div");
    this.#container.className = "tp-demo";

    // Main area: canvas + sidebar
    const main = document.createElement("div");
    main.className = "tp-demo-main";

    // Canvas
    this.#canvas = document.createElement("div");
    this.#canvas.className = "tp-demo-canvas";
    this.#canvas.addEventListener("pointermove", this.#onCanvasMove);
    main.appendChild(this.#canvas);

    // Sidebar
    const sidebar = document.createElement("div");
    sidebar.className = "tp-demo-sidebar";

    // Identity
    sidebar.appendChild(this.#createSection("You", this.#createIdentityRow()));

    // Connection toggle
    this.#toggleDot = document.createElement("div");
    this.#toggleDot.className = "tp-demo-toggle-dot tp-demo-toggle-online";
    this.#toggleLabel = document.createElement("span");
    this.#toggleLabel.textContent = "Online";
    this.#toggleBtn = document.createElement("button");
    this.#toggleBtn.className = "tp-demo-toggle tp-demo-toggle-on";
    this.#toggleBtn.appendChild(this.#toggleDot);
    this.#toggleBtn.appendChild(this.#toggleLabel);
    this.#toggleBtn.addEventListener("click", this.#onToggle);
    sidebar.appendChild(this.#createSection("Connection", this.#toggleBtn));

    // Online list
    this.#countEl = document.createElement("span");
    this.#countEl.textContent = "1";
    this.#userListEl = document.createElement("div");
    this.#userListEl.className = "tp-demo-user-list";

    const onlineHeader = document.createElement("div");
    onlineHeader.className = "tp-demo-section-title";
    onlineHeader.textContent = "Online (";
    onlineHeader.appendChild(this.#countEl);
    onlineHeader.appendChild(document.createTextNode(")"));

    const onlineSection = document.createElement("div");
    onlineSection.className = "tp-demo-section tp-demo-section-grow";
    onlineSection.appendChild(onlineHeader);
    onlineSection.appendChild(this.#userListEl);
    sidebar.appendChild(onlineSection);

    // Boop stats
    this.#boopCountEl = document.createElement("div");
    this.#boopCountEl.className = "tp-demo-boop-count";
    this.#boopCountEl.textContent = "0";
    sidebar.appendChild(this.#createSection("Boops received", this.#boopCountEl));

    main.appendChild(sidebar);
    this.#container.appendChild(main);

    // DevTools drawer
    const drawer = document.createElement("div");
    drawer.className = "tp-demo-drawer";

    const drawerBtn = document.createElement("button");
    drawerBtn.className = "tp-demo-drawer-btn";
    drawerBtn.innerHTML =
      '<span class="tp-demo-drawer-arrow">&#9654;</span> Inspect Messages (DevTools)';
    drawerBtn.addEventListener("click", () => {
      this.#devtoolsOpen = !this.#devtoolsOpen;
      this.#devtoolsContainer.style.height = this.#devtoolsOpen ? "320px" : "0";
      drawerBtn
        .querySelector(".tp-demo-drawer-arrow")!
        .classList.toggle("tp-demo-drawer-arrow-open", this.#devtoolsOpen);
      if (this.#devtoolsOpen && !this.#devtoolsMounted) {
        this.#devtoolsMounted = true;
        this.#devtoolsContainer.appendChild(createTeleportalDevtools(getDevtoolsState()));
      }
    });

    this.#devtoolsContainer = document.createElement("div");
    this.#devtoolsContainer.className = "tp-demo-devtools";

    drawer.appendChild(drawerBtn);
    drawer.appendChild(this.#devtoolsContainer);
    this.#container.appendChild(drawer);

    target.appendChild(this.#container);

    // Listen for awareness changes
    provider.awareness.on("change", this.#updatePeers);
    provider.on("state", this.#updateConnectionState);
    this.#updatePeers();

    // Boop listener
    const boopRpc = provider.rpc?.boop as BoopRpc | undefined;
    if (boopRpc) {
      boopRpc.onBooped(() => {
        this.#boopCount++;
        this.#boopCountEl.textContent = String(this.#boopCount);
      });
    }
  }

  #createSection(title: string, content: HTMLElement): HTMLElement {
    const section = document.createElement("div");
    section.className = "tp-demo-section";
    const titleEl = document.createElement("div");
    titleEl.className = "tp-demo-section-title";
    titleEl.textContent = title;
    section.appendChild(titleEl);
    section.appendChild(content);
    return section;
  }

  #createIdentityRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "tp-demo-identity";
    const dot = document.createElement("div");
    dot.className = "tp-demo-dot";
    dot.style.backgroundColor = this.#identity.color;
    row.appendChild(dot);
    const name = document.createElement("span");
    name.className = "tp-demo-identity-name";
    name.textContent = this.#identity.name;
    row.appendChild(name);
    return row;
  }

  #onCanvasMove = (e: PointerEvent) => {
    const rect = this.#canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const state = (this.#provider.awareness.getLocalState() as any)?.user;
    this.#provider.awareness.setLocalStateField("user", {
      ...(state ?? {}),
      cursor: { x, y },
    });
  };

  #onToggle = () => {
    if (this.#connected) {
      this.#provider.connection.disconnect();
    } else {
      this.#provider.connection.connect();
    }
  };

  #updateConnectionState = () => {
    this.#connected = this.#provider.state !== "disconnected";
    this.#toggleBtn.className = `tp-demo-toggle ${this.#connected ? "tp-demo-toggle-on" : "tp-demo-toggle-off"}`;
    this.#toggleDot.className = `tp-demo-toggle-dot ${this.#connected ? "tp-demo-toggle-online" : "tp-demo-toggle-offline"}`;
    this.#toggleLabel.textContent = this.#connected ? "Online" : "Offline";
  };

  #updatePeers = () => {
    const states = this.#provider.awareness.getStates();
    const localId = this.#provider.awareness.clientID;
    const peers: PeerInfo[] = [];

    states.forEach((state: any, id: number) => {
      if (id === localId) return;
      if (!state.user) return;
      peers.push({
        awarenessId: id,
        name: state.user.name ?? "Anonymous",
        color: state.user.color ?? "#888",
        cursor: state.user.cursor ?? null,
      });
    });

    const total = peers.length + (this.#connected ? 1 : 0);
    this.#countEl.textContent = String(total);

    // Update user list
    this.#userListEl.innerHTML = "";
    if (this.#connected) {
      this.#userListEl.appendChild(
        this.#createUserRow(this.#identity.name, this.#identity.color, true),
      );
    }
    for (const peer of peers) {
      this.#userListEl.appendChild(this.#createUserRow(peer.name, peer.color, false));
    }

    // Update canvas cursors
    const existing = this.#canvas.querySelectorAll(".tp-demo-cursor");
    existing.forEach((el) => el.remove());

    for (const peer of peers) {
      if (!peer.cursor) continue;
      const cursor = document.createElement("div");
      cursor.className = "tp-demo-cursor";
      cursor.style.left = `${peer.cursor.x}%`;
      cursor.style.top = `${peer.cursor.y}%`;
      cursor.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5.65 1.45L1.27 15.59L6.89 12.02L10.55 18.01L12.84 16.69L9.18 10.7L15.38 10.17L5.65 1.45Z" fill="${peer.color}" stroke="#000" stroke-width="0.5"/></svg><span class="tp-demo-cursor-label" style="background:${peer.color}">${peer.name}</span>`;
      this.#canvas.appendChild(cursor);
    }

    // Placeholder when alone
    let placeholder = this.#canvas.querySelector(".tp-demo-placeholder");
    if (peers.length === 0) {
      if (!placeholder) {
        placeholder = document.createElement("div");
        placeholder.className = "tp-demo-placeholder";
        placeholder.innerHTML =
          "<p>Move your cursor here</p><p>Open another tab to see live cursors</p>";
        this.#canvas.appendChild(placeholder);
      }
    } else if (placeholder) {
      placeholder.remove();
    }
  };

  #createUserRow(name: string, color: string, isYou: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "tp-demo-user";
    const dot = document.createElement("div");
    dot.className = "tp-demo-dot";
    dot.style.backgroundColor = color;
    row.appendChild(dot);
    const nameEl = document.createElement("span");
    nameEl.textContent = name;
    nameEl.style.flex = "1";
    row.appendChild(nameEl);
    if (isYou) {
      const tag = document.createElement("span");
      tag.className = "tp-demo-you-tag";
      tag.textContent = "(you)";
      row.appendChild(tag);
    }
    return row;
  }

  destroy() {
    this.#provider.awareness.off("change", this.#updatePeers);
    this.#provider.off("state", this.#updateConnectionState);
    this.#container.remove();
  }
}
