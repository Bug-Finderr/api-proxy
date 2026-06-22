import { Hono } from "hono";
import type { Env, CoarseProvider } from "../types";
import { createToken, listTokens, updateToken, deleteToken } from "../tokens";
import { loginPage, dashboardPage, tokenTable, tokenRow, createdNotice } from "./views";

const COOKIE = "cm_admin";
const MAX_AGE = 86400; // 24h

async function hmac(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthed(req: Request, secret: string): Promise<boolean> {
	const m = (req.headers.get("cookie") || "").match(new RegExp(`${COOKIE}=([^;]+)`));
	if (!m) return false;
	const [ts, sig] = m[1].split(".");
	if (!ts || !sig || Date.now() / 1000 - Number(ts) > MAX_AGE) return false;
	return sig === (await hmac(secret, ts));
}

async function makeCookie(secret: string): Promise<string> {
	const ts = String(Math.floor(Date.now() / 1000));
	return `${COOKIE}=${ts}.${await hmac(secret, ts)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

const VALID_PROVIDERS: CoarseProvider[] = ["openai", "anthropic", "gemini"];
const parseProviders = (fd: FormData): CoarseProvider[] =>
	fd.getAll("providers").map(String).filter((p): p is CoarseProvider => VALID_PROVIDERS.includes(p as CoarseProvider));

const app = new Hono<{ Bindings: Env }>().basePath("/admin");

// Login is the only unguarded route (registered before the auth guard).
app.post("/login", async (c) => {
	const body = await c.req.parseBody();
	if (!c.env.ADMIN_SECRET || body.password !== c.env.ADMIN_SECRET) return c.text("invalid password", 401);
	return c.body("ok", 200, {
		"Set-Cookie": await makeCookie(c.env.ADMIN_SECRET),
		"HX-Redirect": "/admin",
	});
});

// Auth guard for everything below.
app.use("/*", async (c, next) => {
	if (await isAuthed(c.req.raw, c.env.ADMIN_SECRET)) return next();
	if (c.req.path.startsWith("/admin/api/")) return c.text("unauthorized", 401);
	return c.html(loginPage());
});

app.get("/", (c) => c.html(dashboardPage()));

app.get("/logout", (c) =>
	c.body(null, 302, { Location: "/admin", "Set-Cookie": `${COOKIE}=; Path=/admin; Max-Age=0` }),
);

app.get("/api/tokens", async (c) => c.html(tokenTable(await listTokens(c.env.TOKENS))));

app.post("/api/tokens", async (c) => {
	const fd = await c.req.formData();
	const providers = parseProviders(fd);
	const custom = fd.get("token");
	const { token, hash, meta } = await createToken(c.env.TOKENS, {
		label: String(fd.get("label") || ""),
		providers: providers.length ? providers : ["openai"],
		token: custom ? String(custom) : undefined,
	});
	return c.html(createdNotice(token, { hash, ...meta }), 200, { "HX-Trigger": "tokens-changed" });
});

app.put("/api/tokens/:hash", async (c) => {
	const fd = await c.req.formData();
	const patch: Partial<{ label: string; status: "active" | "disabled"; providers: CoarseProvider[] }> = {};
	if (fd.has("label")) patch.label = String(fd.get("label"));
	if (fd.has("status")) patch.status = String(fd.get("status")) === "disabled" ? "disabled" : "active";
	if (fd.has("providers")) patch.providers = parseProviders(fd);
	const meta = await updateToken(c.env.TOKENS, c.req.param("hash"), patch);
	if (!meta) return c.text("not found", 404);
	return c.html(tokenRow({ hash: c.req.param("hash"), ...meta }), 200, { "HX-Trigger": "tokens-changed" });
});

app.delete("/api/tokens/:hash", async (c) => {
	await deleteToken(c.env.TOKENS, c.req.param("hash"));
	return c.body("", 200, { "HX-Trigger": "tokens-changed" });
});

export default app;
