import { manifest, html, fetch, websocket } from "./app";

Bun.serve({
  development: {},
  routes: {
    "/": html,
  },
  fetch,
  websocket,
});

console.info(`Access Control demo on http://localhost:${Bun.env.PORT ?? 1235}`);
