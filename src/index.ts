import adminApp from "./admin";
import { handleProxy } from "./proxy";
import type { Env } from "./types";
import { handleWsProxy } from "./ws";

export { UsEgress } from "./proxy";

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket")
      return handleWsProxy(req, env, ctx);
    const url = new URL(req.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      return adminApp.fetch(req, env, ctx);
    return handleProxy(req, env, ctx);
  },
};
