import { Hono } from "hono";
import {
  createToken,
  deleteToken,
  listTokens,
  sha256hex,
  updateToken,
} from "../tokens";
import type { CoarseProvider, Env } from "../types";
import {
  createdNotice,
  dashboardPage,
  loginPage,
  tokenRow,
  tokenTable,
} from "./views";

const COOKIE = "cm_admin";
const MAX_AGE = 86400; // 24h

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(h: string): Uint8Array | null {
  if (h.length === 0 || h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function isAuthed(req: Request, secret: string): Promise<boolean> {
  const m = (req.headers.get("cookie") || "").match(
    new RegExp(`${COOKIE}=([^;]+)`),
  );
  if (!m) return false;
  const [ts, sig] = m[1].split(".");
  const t = Number(ts);
  if (!ts || !sig || !Number.isFinite(t) || Date.now() / 1000 - t > MAX_AGE)
    return false;
  const sigBytes = fromHex(sig);
  if (!sigBytes) return false;
  // crypto.subtle.verify is constant-time; never compare HMACs with ===.
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    sigBytes,
    new TextEncoder().encode(ts),
  );
}

async function makeCookie(secret: string): Promise<string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return `${COOKIE}=${ts}.${await sign(secret, ts)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

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

// Login is the only unguarded route (registered before the auth guard). Throttled per client
// IP through a dedicated low-rate limiter (fail-open, like the proxy's) and compared in
// constant time: an internet-facing password prompt must not be a brute-force or timing oracle.
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
  c.body(null, 302, {
    Location: "/admin",
    "Set-Cookie": `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  }),
);

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
    // The token is the only secret between the internet and the real keys: no weak custom
    // tokens, and no silent overwrite (overwriting could resurrect a disabled token).
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
  const { token } = await createToken(c.env.TOKENS, {
    label: String(fd.get("label") || ""),
    providers,
    token: custom || undefined,
    expiresAt,
  });
  return c.html(
    createdNotice(token, providers, new URL(c.req.url).origin),
    200,
    { "HX-Trigger": "tokens-changed" },
  );
});

app.put("/api/tokens/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!isHash(hash)) return c.text("bad token id", 400);
  const fd = await c.req.formData();
  const patch: Partial<{
    label: string;
    status: "active" | "disabled";
    providers: CoarseProvider[];
  }> = {};
  if (fd.has("label")) patch.label = String(fd.get("label"));
  if (fd.has("status")) {
    const s = String(fd.get("status"));
    // Whitelist, don't default: a malformed value must not silently re-enable a token.
    if (s !== "active" && s !== "disabled") return c.text("bad status", 400);
    patch.status = s;
  }
  if (fd.has("providers")) patch.providers = parseProviders(fd);
  const meta = await updateToken(c.env.TOKENS, hash, patch);
  if (!meta) return c.text("not found", 404);
  return c.html(tokenRow({ hash, ...meta }), 200, {
    "HX-Trigger": "tokens-changed",
  });
});

app.delete("/api/tokens/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!isHash(hash)) return c.text("bad token id", 400);
  await deleteToken(c.env.TOKENS, hash);
  return c.body("", 200, { "HX-Trigger": "tokens-changed" });
});

export default app;
