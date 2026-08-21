import type { Awareness } from "y-protocols/awareness";

export class BoopEffect {
  #awareness: Awareness;

  constructor(awareness: Awareness) {
    this.#awareness = awareness;
  }

  trigger(fromAwarenessId: number) {
    const states = this.#awareness.getStates();
    const fromState = states.get(fromAwarenessId) as
      | { user?: { name?: string; color?: string } }
      | undefined;
    const name = fromState?.user?.name ?? "Someone";
    const color = fromState?.user?.color ?? "#ee6352";

    this.#showBurst(color);
    this.#showToast(name);
  }

  #showBurst(color: string) {
    const local = this.#awareness.getLocalState() as any;
    const cursor = local?.user?.cursor;
    if (!cursor) return;

    const burst = document.createElement("div");
    burst.className = "tp-boop-burst";
    burst.style.left = `${cursor.x}px`;
    burst.style.top = `${cursor.y}px`;
    burst.style.border = `3px solid ${color}`;
    document.body.appendChild(burst);
    burst.addEventListener("animationend", () => burst.remove());
  }

  #showToast(name: string) {
    const toast = document.createElement("div");
    toast.className = "tp-boop-toast";
    toast.textContent = `${name} booped you!`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("tp-toast-out");
      toast.addEventListener("animationend", () => toast.remove());
    }, 1800);
  }

  destroy() {}
}
