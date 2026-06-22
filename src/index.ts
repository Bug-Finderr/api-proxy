import type { Env } from "./types";
import { handleProxy } from "./proxy";

// Top-level dispatch: /admin/* -> admin sub-app (wired in a later step), everything else -> proxy.
export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
			return new Response("admin not implemented", { status: 501 });
		}
		return handleProxy(req, env, ctx);
	},
};
