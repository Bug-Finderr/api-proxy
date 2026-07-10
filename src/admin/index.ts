import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import { timingSafeEqual } from "hono/utils/buffer";
import {
  createToken,
  deleteToken,
  listTokens,
  setTokenStatus,
  sha256hex,
} from "../tokens";
import type { CoarseProvider, Env } from "../types";
import {
  createdNotice,
  dashboardPage,
  HTMX,
  loginPage,
  tokenRow,
  tokenTable,
} from "./views";

const COOKIE = "ap_admin";
const MAX_AGE = 86400;

const isHash = (h: string) => /^[0-9a-f]{64}$/.test(h);

const VALID_PROVIDERS: CoarseProvider[] = ["openai", "anthropic", "gemini"];
const parseProviders = (fd: FormData): CoarseProvider[] =>
  fd
    .getAll("providers")
    .map(String)
    .filter((p): p is CoarseProvider =>
      VALID_PROVIDERS.includes(p as CoarseProvider),
    );

const app = new Hono<{ Bindings: Env }>().basePath("/admin");

// HTMX compiles hx-on and filtered hx-trigger attributes with Function.
app.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'unsafe-eval'", HTMX],
      styleSrc: ["'unsafe-inline'"],
      connectSrc: ["'self'"],
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
    (await timingSafeEqual(String(body.password || ""), c.env.ADMIN_SECRET));
  if (!ok) {
    console.warn("admin login failed");
    return c.text("invalid password", 401);
  }
  // Signing the issue time lets the server enforce the 24-hour expiry.
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
  return c.redirect("/admin");
});

app.get("/api/tokens", async (c) =>
  c.html(tokenTable(await listTokens(c.env.TOKENS))),
);

app.post("/api/tokens", async (c) => {
  const fd = await c.req.formData();
  const label = String(fd.get("label") || "").trim();
  if (!label) return c.text("label is required", 400);
  const providers = parseProviders(fd);
  if (!providers.length) return c.text("pick at least one provider", 400);
  const custom = String(fd.get("token") || "").trim();
  if (custom) {
    if (custom.length < 12)
      return c.text("custom token too short (min 12 chars)", 400);
    if (await c.env.TOKENS.get(await sha256hex(custom)))
      return c.text("token already exists - delete it first", 409);
  }
  const rawExp = String(fd.get("expiresAt") || "").trim();
  let expiresAt: string | undefined;
  if (rawExp) {
    // The browser submits UTC ISO; an offset-less value would parse in the runtime's local tz, so reject it.
    const d = new Date(rawExp);
    if (Number.isNaN(d.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/i.test(rawExp))
      return c.text("invalid expiry", 400);
    expiresAt = d.toISOString();
  }
  const { token, hash, meta } = await createToken(c.env.TOKENS, {
    label,
    providers,
    token: custom || undefined,
    expiresAt,
  });
  // KV list() can lag by 60 seconds or more, so return the new row out-of-band.
  return c.html(
    html`${createdNotice(token, providers, new URL(c.req.url).origin)}
		<template><tbody hx-swap-oob="afterbegin:#rows">${tokenRow({ hash, ...meta })}</tbody></template>`,
  );
});

app.put("/api/tokens/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!isHash(hash)) return c.text("bad token id", 400);
  const status = String((await c.req.formData()).get("status"));
  if (status !== "active" && status !== "disabled")
    return c.text("bad status", 400);
  const meta = await setTokenStatus(c.env.TOKENS, hash, status);
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
