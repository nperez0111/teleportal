let injected = false;

export function injectStyles() {
  if (injected) return;
  injected = true;

  const style = document.createElement("style");
  style.textContent = `
    /* Cursor base styles (layer, positioning, label) come from
       teleportal/cursors. These are the docs-only dwell-to-boop affordances. */
    .tp-cursor-pointer {
      transition: transform 150ms ease;
    }

    .tp-cursor-pointer.tp-cursor-boopable {
      transform: scale(1.3);
    }

    .tp-cursor-pointer.tp-cursor-boopable .tp-cursor-arrow {
      filter: drop-shadow(0 0 8px var(--tp-cursor-color));
    }

    .tp-presence-widget {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 99998;
      font-family: system-ui, -apple-system, sans-serif;
    }

    .tp-presence-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      background: rgba(24, 24, 27, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #a1a1aa;
      font-size: 13px;
      cursor: pointer;
      user-select: none;
      transition: background 150ms ease, border-color 150ms ease;
    }

    .tp-presence-pill:hover {
      background: rgba(39, 39, 42, 0.9);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .tp-presence-dots {
      display: flex;
      gap: 3px;
    }

    .tp-presence-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      border: 1px solid rgba(0, 0, 0, 0.3);
    }

    .tp-presence-count {
      font-variant-numeric: tabular-nums;
    }

    .tp-presence-boop-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(238, 99, 82, 0.2);
      color: #ee6352;
      font-size: 11px;
      font-weight: 600;
    }

    .tp-presence-panel {
      position: absolute;
      bottom: calc(100% + 8px);
      right: 0;
      width: 320px;
      max-height: 80vh;
      overflow-y: auto;
      background: rgba(24, 24, 27, 0.95);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 12px;
      display: none;
      flex-direction: column;
      gap: 8px;
    }

    .tp-presence-panel.tp-panel-open {
      display: flex;
    }

    .tp-presence-panel-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #71717a;
      margin: 0;
    }

    .tp-presence-user {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #d4d4d8;
    }

    .tp-presence-user-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .tp-presence-user-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tp-presence-user-you {
      font-size: 10px;
      color: #52525b;
    }

    .tp-presence-user-boop {
      opacity: 0;
      font-size: 11px;
      color: #71717a;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
      border: none;
      background: transparent;
      transition: opacity 150ms ease, color 150ms ease;
    }

    .tp-presence-user:hover .tp-presence-user-boop {
      opacity: 1;
    }

    .tp-presence-user-boop:hover {
      color: #e4e4e7;
      background: rgba(255, 255, 255, 0.05);
    }

    .tp-presence-user-scroll {
      opacity: 0;
      font-size: 11px;
      color: #71717a;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
      border: none;
      background: transparent;
      transition: opacity 150ms ease, color 150ms ease;
    }

    .tp-presence-user:hover .tp-presence-user-scroll {
      opacity: 1;
    }

    .tp-presence-user-scroll:hover {
      color: #e4e4e7;
      background: rgba(255, 255, 255, 0.05);
    }

    .tp-presence-devtools-toggle {
      width: 100%;
      padding: 6px 8px;
      margin-top: 4px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      color: #71717a;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      font-family: system-ui, -apple-system, sans-serif;
      text-align: center;
      transition: color 150ms ease, background 150ms ease;
    }

    .tp-presence-devtools-toggle:hover {
      color: #a1a1aa;
      background: rgba(255, 255, 255, 0.08);
    }

    .tp-presence-devtools {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 0;
      z-index: 99997;
      overflow: hidden;
      background: rgba(15, 15, 20, 0.98);
      backdrop-filter: blur(12px);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      transition: height 250ms ease;
    }

    .tp-presence-devtools.tp-devtools-open {
      height: 40vh;
    }

    @keyframes tp-boop-burst {
      0% { transform: scale(0.5); opacity: 1; }
      100% { transform: scale(2.5); opacity: 0; }
    }

    .tp-boop-burst {
      position: fixed;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      pointer-events: none;
      z-index: 100000;
      animation: tp-boop-burst 600ms ease-out forwards;
      transform: translate(-50%, -50%);
    }

    @keyframes tp-boop-toast-in {
      0% { transform: translateY(20px); opacity: 0; }
      100% { transform: translateY(0); opacity: 1; }
    }

    @keyframes tp-boop-toast-out {
      0% { transform: translateY(0); opacity: 1; }
      100% { transform: translateY(-10px); opacity: 0; }
    }

    .tp-boop-toast {
      position: fixed;
      bottom: 64px;
      right: 16px;
      z-index: 100000;
      padding: 8px 16px;
      border-radius: 10px;
      background: rgba(24, 24, 27, 0.95);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(238, 99, 82, 0.3);
      color: #e4e4e7;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 500;
      pointer-events: none;
      animation: tp-boop-toast-in 200ms ease-out;
    }

    .tp-boop-toast.tp-toast-out {
      animation: tp-boop-toast-out 200ms ease-in forwards;
    }

    /* Homepage demo */
    .tp-demo {
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(24, 24, 27, 0.7);
      backdrop-filter: blur(8px);
      overflow: hidden;
      font-family: system-ui, -apple-system, sans-serif;
      color: #d4d4d8;
      font-size: 13px;
    }

    .tp-demo-main {
      display: flex;
      min-height: 360px;
    }

    .tp-demo-canvas {
      flex: 1;
      position: relative;
      overflow: hidden;
      border-radius: 12px;
      background-image: radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px);
      background-size: 20px 20px;
      background-color: rgba(10, 10, 15, 0.6);
    }

    .tp-demo-cursor {
      position: absolute;
      pointer-events: none;
      transform: translate(-2px, -2px);
      transition: left 80ms linear, top 80ms linear;
    }

    .tp-demo-cursor-label {
      position: absolute;
      left: 18px;
      top: 0;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      white-space: nowrap;
      color: #000;
    }

    .tp-demo-placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: rgba(161, 161, 170, 0.6);
      gap: 4px;
      pointer-events: none;
    }

    .tp-demo-placeholder p {
      margin: 0;
      font-size: 14px;
    }

    .tp-demo-placeholder p:last-child {
      font-size: 12px;
    }

    .tp-demo-sidebar {
      width: 200px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      border-left: 1px solid rgba(255, 255, 255, 0.06);
    }

    .tp-demo-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .tp-demo-section-grow {
      flex: 1;
      min-height: 0;
    }

    .tp-demo-section-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #71717a;
    }

    .tp-demo-identity {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tp-demo-identity-name {
      font-weight: 500;
    }

    .tp-demo-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .tp-demo-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: system-ui, -apple-system, sans-serif;
      transition: all 200ms;
    }

    .tp-demo-toggle-on {
      background: rgba(110, 235, 131, 0.08);
      color: #6eeb83;
    }

    .tp-demo-toggle-off {
      background: rgba(238, 99, 82, 0.08);
      color: #ee6352;
    }

    .tp-demo-toggle-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      transition: background-color 200ms;
    }

    .tp-demo-toggle-online { background-color: #6eeb83; }
    .tp-demo-toggle-offline { background-color: #ee6352; }

    .tp-demo-user-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .tp-demo-user {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }

    .tp-demo-you-tag {
      font-size: 10px;
      color: #52525b;
    }

    .tp-demo-boop-count {
      font-size: 28px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    .tp-demo-drawer {
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .tp-demo-drawer-btn {
      width: 100%;
      padding: 8px 16px;
      background: transparent;
      border: none;
      color: #71717a;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: system-ui, -apple-system, sans-serif;
      text-align: left;
    }

    .tp-demo-drawer-btn:hover {
      color: #a1a1aa;
    }

    .tp-demo-drawer-arrow {
      display: inline-block;
      transition: transform 150ms;
      font-size: 10px;
    }

    .tp-demo-drawer-arrow-open {
      transform: rotate(90deg);
    }

    .tp-demo-devtools {
      height: 0;
      overflow: hidden;
      transition: height 200ms ease;
    }
  `;
  document.head.appendChild(style);
}
