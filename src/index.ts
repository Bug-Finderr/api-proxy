import type { Env } from "./types";
import { handleProxy } from "./proxy";
import adminApp from "./admin";

// Top-level dispatch: /admin/* -> admin sub-app (isolated in try/catch so an admin
// bug can never crash the proxy branch), everything else -> the proxy hot-path.
export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
			try {
				return await adminApp.fetch(req, env, ctx);
			} catch {
				return new Response("admin error", { status: 500 });
			}
		}
		return handleProxy(req, env, ctx);
	},
};
