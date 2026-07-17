import { Provider } from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { createBoopRpc, type BoopRpc } from "../../../../examples/awareness/src/boop-client";
import { getOrCreateIdentity } from "./identity";
import { injectStyles } from "./styles";
import { CursorOverlay } from "./overlay";
import { PresenceWidget } from "./presence-widget";
import { BoopEffect } from "./boop-effect";
import { HomepageDemo } from "./homepage-demo";

const DEMO_SERVER =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:1235/awareness/"
    : "https://demo.teleportal.tools/awareness/";

const tokenManager = createTokenManager({
  secret: "awareness-demo-secret",
  expiresIn: 3600,
  issuer: "awareness-demo",
});

let provider: Provider | null = null;
let overlay: CursorOverlay | null = null;
let widget: PresenceWidget | null = null;
let boopEffect: BoopEffect | null = null;
let initialized = false;

export function getProvider(): Provider | null {
  return provider;
}

export async function init() {
  if (initialized) return;
  initialized = true;

  injectStyles();

  const identity = getOrCreateIdentity();
  const pathHash = Array.from(new TextEncoder().encode(window.location.pathname))
    .reduce((h, b) => Math.imul(h ^ b, 0x01000193) >>> 0, 0x811c9dc5)
    .toString(36);
  const document = `docs-${pathHash}`;

  const token = await tokenManager.createToken(
    identity.name,
    "awareness",
    new DocumentAccessBuilder().admin("*").build(),
  );

  provider = await Provider.create({
    url: `${DEMO_SERVER}?token=${token}`,
    document,
    encryptionKey: false,
    rpc: { boop: createBoopRpc },
  });

  provider.awareness.setLocalStateField("user", {
    name: identity.name,
    color: identity.color,
    cursor: null,
  });

  overlay = new CursorOverlay(provider.awareness);
  widget = new PresenceWidget(provider.awareness, identity);
  boopEffect = new BoopEffect(provider.awareness);

  const boopRpc = provider.rpc.boop as BoopRpc;

  const sendBoop = (targetId: number) => {
    boopRpc.send(targetId);
  };

  overlay.onBoopTarget = sendBoop;
  widget.onBoopUser = sendBoop;

  boopRpc.onBooped((fromId) => {
    boopEffect!.trigger(fromId);
    widget!.incrementBoopCount();
  });

  // Mount homepage demo if on the homepage
  const demoRoot = globalThis.document.getElementById("homepage-demo-root");
  if (demoRoot) {
    new HomepageDemo(demoRoot, provider, identity);
  }

  // Lazy connection: disconnect after 30s of being hidden, reconnect on visible
  let visibilityTimer: ReturnType<typeof setTimeout> | null = null;
  globalThis.document.addEventListener("visibilitychange", () => {
    if (!provider) return;
    if (globalThis.document.visibilityState === "hidden") {
      visibilityTimer = setTimeout(() => {
        provider!.connection.disconnect();
      }, 30_000);
    } else {
      if (visibilityTimer) {
        clearTimeout(visibilityTimer);
        visibilityTimer = null;
      }
      provider.connection.connect();
    }
  });
}

// Self-bootstrapping: defer until idle, only in browser
if (typeof document !== "undefined") {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => init());
  } else {
    setTimeout(() => init(), 0);
  }
}
