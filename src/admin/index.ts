import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import {
  createToken,
  deleteToken,
  listTokens,
  sha256hex,
  updateToken,
} from "../tokens";
import type { CoarseProvider, Env, TokenMetadata } from "../types";
import {
  createdNotice,
  dashboardPage,
  HTMX,
  loginPage,
  tokenRow,
  tokenTable,
} from "./views";

const COOKIE = "cm_admin";
const MAX_AGE = 86400; // 24h

const isHash = (h: string) => /^[0-9a-f]{64}$/.test(h);

/** Constant-time secret comparison: hash both to a fixed length, then timingSafeEqual
 *  (a Workers extension to SubtleCrypto), so neither length nor prefix leaks via timing. */
async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

const VALID_PROVIDERS: CoarseProvider[] = ["openai", "anthropic", "gemini"];
const parseProviders = (fd: FormData): CoarseProvider[] =>
  fd
    .getAll("providers")
    .map(String)
    .filter((p): p is CoarseProvider =>
      VALID_PROVIDERS.includes(p as CoarseProvider),
    );

const app = new Hono<{ Bindings: Env }>().basePath("/admin");

// htmx compiles hx-on handlers and hx-trigger event filters via Function, hence 'unsafe-eval'.
app.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'unsafe-eval'", HTMX],
      styleSrc: ["'unsafe-inline'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
    },
    xFrameOptions: "DENY",
  }),
);

// Login is the only unguarded route (registered before the auth guard).
app.post("/login", async (c) => {
  let allowed = true;
  try {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    allowed = (await c.env.LOGIN_LIMITER.limit({ key: `login:${ip}` })).success;
  } catch {
    allowed = true;
  }
  if (!allowed)
    return c.text("too many login attempts", 429, { "retry-after": "60" });
  const body = await c.req.parseBody();
  const ok =
    !!c.env.ADMIN_SECRET &&
    (await secretsEqual(String(body.password || ""), c.env.ADMIN_SECRET));
  if (!ok) {
    console.warn("admin login failed");
    return c.text("invalid password", 401);
  }
  // The signed value is the issue time: the 24h expiry holds server-side even if the
  // client ignores Max-Age.
  await setSignedCookie(
    c,
    COOKIE,
    String(Math.floor(Date.now() / 1000)),
    c.env.ADMIN_SECRET,
    {
      path: "/admin",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      maxAge: MAX_AGE,
    },
  );
  return c.text("ok", 200, { "HX-Redirect": "/admin" });
});

// Auth guard for everything below. getSignedCookie verifies the HMAC in constant time;
// tampered gives false, absent undefined, and a non-numeric timestamp fails the age check.
app.use("/*", async (c, next) => {
  const ts = await getSignedCookie(c, c.env.ADMIN_SECRET, COOKIE);
  if (typeof ts === "string" && Date.now() / 1000 - Number(ts) <= MAX_AGE)
    return next();
  if (c.req.path.startsWith("/admin/api/")) return c.text("unauthorized", 401);
  return c.html(loginPage());
});

app.get("/", (c) => c.html(dashboardPage()));

app.get("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/admin" });
  return c.body(null, 302, { Location: "/admin" });
});

app.get("/api/tokens", async (c) =>
  c.html(tokenTable(await listTokens(c.env.TOKENS))),
);

app.post("/api/tokens", async (c) => {
  const fd = await c.req.formData();
  const providers = parseProviders(fd);
  // Silent scope substitution is the wrong default for a security control: no boxes, no token.
  if (!providers.length) return c.text("pick at least one provider", 400);
  const custom = String(fd.get("token") || "").trim();
  if (custom) {
    // No weak custom tokens, and no silent overwrite: it could resurrect a disabled token.
    if (custom.length < 12)
      return c.text("custom token too short (min 12 chars)", 400);
    if (await c.env.TOKENS.get(await sha256hex(custom)))
      return c.text("token already exists - delete it first", 409);
  }
  const rawExp = String(fd.get("expiresAt") || "").trim();
  let expiresAt: string | undefined;
  if (rawExp) {
    // The form submits UTC ISO (converted in the browser). An offset-less value is rejected:
    // it would be read in the runtime's local timezone (UTC in production, host tz in dev).
    const d = new Date(rawExp);
    if (Number.isNaN(d.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/i.test(rawExp))
      return c.text("invalid expiry", 400);
    expiresAt = d.toISOString();
  }
  const { token, hash, meta } = await createToken(c.env.TOKENS, {
    label: String(fd.get("label") || ""),
    providers,
    token: custom || undefined,
    expiresAt,
  });
  // KV list() lags writes by up to 60s, so a table refresh can't show the new token;
  // the response carries the authoritative row itself, swapped in out-of-band. The tbody
  // is the disposable carrier htmx unwraps (non-outerHTML OOB inserts content, not element).
  return c.html(
    html`${createdNotice(token, providers, new URL(c.req.url).origin)}
		<template><tbody hx-swap-oob="afterbegin:#rows">${tokenRow({ hash, ...meta })}</tbody></template>`,
  );
});

app.put("/api/tokens/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!isHash(hash)) return c.text("bad token id", 400);
  const fd = await c.req.formData();
  const patch: Partial<Pick<TokenMetadata, "label" | "providers" | "status">> =
    {};
  if (fd.has("label")) patch.label = String(fd.get("label"));
  if (fd.has("status")) {
    const s = String(fd.get("status"));
    // Whitelist, don't default: a malformed value must not silently re-enable a token.
    if (s !== "active" && s !== "disabled") return c.text("bad status", 400);
    patch.status = s;
  }
  if (fd.has("providers")) {
    patch.providers = parseProviders(fd);
    if (!patch.providers.length)
      return c.text("pick at least one provider", 400);
  }
  const meta = await updateToken(c.env.TOKENS, hash, patch);
  if (!meta) return c.text("not found", 404);
  return c.html(tokenRow({ hash, ...meta }));
});

app.delete("/api/tokens/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!isHash(hash)) return c.text("bad token id", 400);
  await deleteToken(c.env.TOKENS, hash);
  return c.body("", 200);
});

export default app;
