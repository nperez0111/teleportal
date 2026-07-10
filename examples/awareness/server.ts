import { manifest, html, fetch, websocket } from "./app";

const instance = Bun.serve({
  development: {},
  routes: { "/": html },
  fetch,
  websocket,
});

console.info(`${manifest.title} on http://${instance.hostname}:${instance.port}`);
