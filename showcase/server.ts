import * as accessControl from "../examples/access-control/app";
import * as awareness from "../examples/awareness/app";
import * as blocknote from "../examples/blocknote/app";
import * as excalidraw from "../examples/excalidraw/app";
import * as fileSystem from "../examples/file-system/app";
import * as prosemirror from "../examples/prosemirror/app";
import * as reactFlow from "../examples/react-flow/app";

import landing from "./landing/index.html";

const apps = [accessControl, awareness, blocknote, excalidraw, fileSystem, prosemirror, reactFlow];
const bySlug = new Map(apps.map((a) => [a.manifest.slug, a]));

const instance = Bun.serve({
  development: {},
  routes: {
    "/": landing,
    ...Object.fromEntries(
      apps.flatMap((a) => [
        [`/${a.manifest.slug}`, a.html],
        [`/${a.manifest.slug}/`, a.html],
      ]),
    ),
  },
  websocket: {
    open(ws: any) {
      bySlug.get(ws.data.appSlug)?.websocket.open(ws);
    },
    message(ws: any, msg: any) {
      bySlug.get(ws.data.appSlug)?.websocket.message(ws, msg);
    },
    close(ws: any) {
      bySlug.get(ws.data.appSlug)?.websocket.close(ws);
    },
    drain(ws: any) {
      bySlug.get(ws.data.appSlug)?.websocket.drain?.(ws);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/health") {
      return Response.json({ status: "ok", apps: apps.map((a) => a.manifest.slug) });
    }

    if (pathname === "/api/apps") {
      return Response.json(apps.map((a) => a.manifest));
    }

    const segments = pathname.split("/");
    const slug = segments[1];
    const app = bySlug.get(slug!);

    if (app) {
      // WebSocket upgrades must use the original request for Bun's server.upgrade() handshake
      if (request.headers.get("upgrade") === "websocket") {
        return app.fetch(request, server);
      }
      const strippedPath = "/" + segments.slice(2).join("/");
      const rewritten = new Request(new URL(strippedPath + url.search, url.origin), request);
      return app.fetch(rewritten, server);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.info(`Teleportal Showcase on http://${instance.hostname}:${instance.port}`);
console.info(`  Apps: ${apps.map((a) => `/${a.manifest.slug}/`).join(", ")}`);
