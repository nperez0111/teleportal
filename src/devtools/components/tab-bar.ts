export type DevtoolsTab = {
  id: string;
  label: string;
};

export class TabBar {
  private element: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private badges = new Map<string, HTMLElement>();
  private activeId: string;

  constructor(tabs: DevtoolsTab[], onChange: (id: string) => void) {
    this.element = document.createElement("div");
    this.element.className = "devtools-tab-bar";
    this.activeId = tabs[0]?.id ?? "";

    for (const tab of tabs) {
      const button = document.createElement("button");
      button.className = "devtools-tab";
      button.textContent = tab.label;
      button.addEventListener("click", () => {
        if (this.activeId === tab.id) return;
        this.setActive(tab.id);
        onChange(tab.id);
      });
      this.buttons.set(tab.id, button);
      this.element.append(button);
    }

    this.setActive(this.activeId);
  }

  setActive(id: string) {
    this.activeId = id;
    for (const [tabId, button] of this.buttons) {
      button.classList.toggle("devtools-tab-active", tabId === id);
    }
  }

  getActive(): string {
    return this.activeId;
  }

  /** Shows a small count badge on a tab (e.g. peer count); null hides it. */
  setBadge(id: string, text: string | null) {
    const button = this.buttons.get(id);
    if (!button) return;
    let badge = this.badges.get(id);
    if (text === null) {
      badge?.remove();
      this.badges.delete(id);
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "devtools-tab-badge";
      button.append(badge);
      this.badges.set(id, badge);
    }
    if (badge.textContent !== text) badge.textContent = text;
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
