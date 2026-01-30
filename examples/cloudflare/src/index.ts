/// <reference types="@cloudflare/workers-types" />
import crossws from "crossws/adapters/cloudflare";
import { TeleportalDO } from "./TeleportalDO";

export { TeleportalDO };

interface Env {
  TELEPORTAL_DO: DurableObjectNamespace;
}

const ws = crossws({
  bindingName: "TELEPORTAL_DO",
  instanceName: "teleportal",
  hooks: {},
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, env, ctx);
    }
    const id = env.TELEPORTAL_DO.idFromName("teleportal");
    const stub = env.TELEPORTAL_DO.get(id);
    return stub.fetch(request);
  },
};
