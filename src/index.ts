import adminApp from "./admin";
import { handleProxy } from "./proxy";
import type { Env } from "./types";
import { handleWsProxy } from "./ws";

export { UsEgress } from "./egress";

// Top-level dispatch: a WebSocket upgrade -> the wss proxy; /admin/* -> admin sub-app (isolated
// in try/catch so an admin bug can never crash the proxy branch); everything else -> the proxy
// hot-path.
export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket")
      return handleWsProxy(req, env, ctx);
    const url = new URL(req.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      try {
        return await adminApp.fetch(req, env, ctx);
      } catch (err) {
        console.error("admin route error", err);
        return new Response("admin error", { status: 500 });
      }
    }
    return handleProxy(req, env, ctx);
  },
};
