import { createTeleportalDevtools, getDevtoolsState } from "teleportal/devtools";
import type { Awareness } from "y-protocols/awareness";
import type { Identity } from "./identity";

interface PeerInfo {
  name: string;
  color: string;
  cursorPctY: number | null;
}

export class PresenceWidget {
  #container: HTMLElement;
  #pill: HTMLElement;
  #panel: HTMLElement;
  #countEl: HTMLElement;
  #dotsEl: HTMLElement;
  #userListEl: HTMLElement;
  #boopBadge: HTMLElement;
  #devtoolsContainer: HTMLElement;
  #devtoolsMounted = false;
  #devtoolsOpen = false;
  #awareness: Awareness;
  #identity: Identity;
  #boopCount = 0;
  #panelOpen = false;
  #onBoopUser: ((awarenessId: number) => void) | null = null;

  constructor(awareness: Awareness, identity: Identity) {
    this.#awareness = awareness;
    this.#identity = identity;

    this.#container = document.createElement("div");
    this.#container.className = "tp-presence-widget";

    // Panel (above pill)
    this.#panel = document.createElement("div");
    this.#panel.className = "tp-presence-panel";

    const title = document.createElement("p");
    title.className = "tp-presence-panel-title";
    title.textContent = "Online";
    this.#panel.appendChild(title);

    this.#userListEl = document.createElement("div");
    this.#panel.appendChild(this.#userListEl);

    // DevTools toggle button (inside panel)
    const devtoolsToggle = document.createElement("button");
    devtoolsToggle.className = "tp-presence-devtools-toggle";
    devtoolsToggle.textContent = "Inspect Messages";
    devtoolsToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#devtoolsOpen = !this.#devtoolsOpen;
      this.#devtoolsContainer.classList.toggle("tp-devtools-open", this.#devtoolsOpen);
      if (this.#devtoolsOpen && !this.#devtoolsMounted) {
        this.#devtoolsMounted = true;
        this.#devtoolsContainer.appendChild(createTeleportalDevtools(getDevtoolsState()));
      }
    });
    this.#panel.appendChild(devtoolsToggle);

    // DevTools container — fixed to bottom of viewport, full width
    this.#devtoolsContainer = document.createElement("div");
    this.#devtoolsContainer.className = "tp-presence-devtools";
    document.body.appendChild(this.#devtoolsContainer);

    this.#container.appendChild(this.#panel);

    // Pill
    this.#pill = document.createElement("div");
    this.#pill.className = "tp-presence-pill";

    this.#dotsEl = document.createElement("div");
    this.#dotsEl.className = "tp-presence-dots";
    this.#pill.appendChild(this.#dotsEl);

    this.#countEl = document.createElement("span");
    this.#countEl.className = "tp-presence-count";
    this.#pill.appendChild(this.#countEl);

    this.#boopBadge = document.createElement("span");
    this.#boopBadge.className = "tp-presence-boop-badge";
    this.#boopBadge.style.display = "none";
    this.#pill.appendChild(this.#boopBadge);

    this.#pill.addEventListener("click", () => {
      this.#panelOpen = !this.#panelOpen;
      this.#panel.classList.toggle("tp-panel-open", this.#panelOpen);
    });

    this.#container.appendChild(this.#pill);
    document.body.appendChild(this.#container);

    // Close panel when clicking outside
    document.addEventListener("click", (e) => {
      if (this.#panelOpen && !this.#container.contains(e.target as Node)) {
        this.#panelOpen = false;
        this.#panel.classList.remove("tp-panel-open");
      }
    });

    this.#awareness.on("change", this.#update);
    this.#update();
  }

  set onBoopUser(fn: ((awarenessId: number) => void) | null) {
    this.#onBoopUser = fn;
  }

  incrementBoopCount() {
    this.#boopCount++;
    this.#boopBadge.textContent = `${this.#boopCount}`;
    this.#boopBadge.style.display = "";
  }

  #update = () => {
    const states = this.#awareness.getStates();
    const localId = this.#awareness.clientID;
    const peers: { id: number; info: PeerInfo }[] = [];

    states.forEach((state: any, id: number) => {
      if (id === localId) return;
      if (!state.user) return;
      peers.push({
        id,
        info: {
          name: state.user.name ?? "Anonymous",
          color: state.user.color ?? "#888",
          cursorPctY: state.user.cursor?.y ?? null,
        },
      });
    });

    const total = peers.length + 1;
    this.#countEl.textContent = `${total} online`;

    // Dots
    this.#dotsEl.innerHTML = "";
    const dot = document.createElement("div");
    dot.className = "tp-presence-dot";
    dot.style.backgroundColor = this.#identity.color;
    this.#dotsEl.appendChild(dot);
    for (const peer of peers.slice(0, 4)) {
      const d = document.createElement("div");
      d.className = "tp-presence-dot";
      d.style.backgroundColor = peer.info.color;
      this.#dotsEl.appendChild(d);
    }

    // User list in panel
    this.#userListEl.innerHTML = "";

    const self = this.#createUserRow(this.#identity.name, this.#identity.color, null, true, null);
    this.#userListEl.appendChild(self);

    for (const peer of peers) {
      const row = this.#createUserRow(
        peer.info.name,
        peer.info.color,
        peer.id,
        false,
        peer.info.cursorPctY,
      );
      this.#userListEl.appendChild(row);
    }
  };

  #createUserRow(
    name: string,
    color: string,
    awarenessId: number | null,
    isYou: boolean,
    cursorPctY: number | null,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "tp-presence-user";

    const dot = document.createElement("div");
    dot.className = "tp-presence-user-dot";
    dot.style.backgroundColor = color;
    row.appendChild(dot);

    const nameEl = document.createElement("span");
    nameEl.className = "tp-presence-user-name";
    nameEl.textContent = name;
    row.appendChild(nameEl);

    if (isYou) {
      const youTag = document.createElement("span");
      youTag.className = "tp-presence-user-you";
      youTag.textContent = "(you)";
      row.appendChild(youTag);
    } else {
      // Scroll-to-user button (visible when they have a cursor position)
      if (cursorPctY !== null) {
        const scrollBtn = document.createElement("button");
        scrollBtn.className = "tp-presence-user-scroll";
        scrollBtn.textContent = "go to";
        scrollBtn.title = `Scroll to ${name}'s position`;
        scrollBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const pageY = (cursorPctY / 100) * document.documentElement.scrollHeight;
          window.scrollTo({ top: pageY - window.innerHeight / 2, behavior: "smooth" });
        });
        row.appendChild(scrollBtn);
      }

      if (awarenessId !== null) {
        const boopBtn = document.createElement("button");
        boopBtn.className = "tp-presence-user-boop";
        boopBtn.textContent = "boop";
        boopBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.#onBoopUser?.(awarenessId);
        });
        row.appendChild(boopBtn);
      }
    }

    return row;
  }

  destroy() {
    this.#awareness.off("change", this.#update);
    this.#container.remove();
    this.#devtoolsContainer.remove();
  }
}
