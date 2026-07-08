import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { getValidated, sha256hex } from "../src/tokens";

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://proxy.example${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
});

async function login(): Promise<string> {
  const res = await call(
    "/admin/login",
    form({ password: "test-admin-secret" }),
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0];
}

describe("admin auth", () => {
  it("serves a login page (not the dashboard) when unauthenticated", async () => {
    const res = await call("/admin");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("password");
    // a wrong password must surface, not silently no-op
    expect(page).toContain("login-error");
    expect(page).toContain("hx-on::response-error");
  });
  it("rejects a wrong password", async () => {
    const res = await call("/admin/login", form({ password: "nope" }));
    expect(res.status).toBe(401);
  });
  it("rejects API calls without a valid cookie", async () => {
    const res = await call("/admin/api/tokens");
    expect(res.status).toBe(401);
  });
  it("accepts a valid cookie", async () => {
    const cookie = await login();
    const res = await call("/admin/api/tokens", { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

describe("admin token CRUD", () => {
  it("creates a custom token that the proxy then accepts", async () => {
    const cookie = await login();
    const res = await call("/admin/api/tokens", {
      ...form({
        label: "alice",
        providers: "openai",
        token: "compat-xyz-token",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    expect(res.status).toBe(200);
    expect(await getValidated(env.TOKENS, "compat-xyz-token")).toMatchObject({
      label: "alice",
      providers: ["openai"],
    });
  });

  it("lists tokens by label", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form({
        label: "bob",
        providers: "anthropic",
        token: "list-bob-token",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const res = await call("/admin/api/tokens", { headers: { cookie } });
    expect(await res.text()).toContain("bob");
  });

  it("disables a token so the proxy rejects it", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form({ label: "c", providers: "gemini", token: "to-disable-token" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const hash = await sha256hex("to-disable-token");
    const upd = await call(`/admin/api/tokens/${hash}`, {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ status: "disabled" }).toString(),
    });
    expect(upd.status).toBe(200);
    expect(await getValidated(env.TOKENS, "to-disable-token")).toBeNull();
  });

  it("deletes a token", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form({ label: "d", providers: "openai", token: "to-delete-token" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const hash = await sha256hex("to-delete-token");
    const del = await call(`/admin/api/tokens/${hash}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);
    expect(await getValidated(env.TOKENS, "to-delete-token")).toBeNull();
  });

  it("stores a UTC ISO expiresAt and 400s an unparseable one", async () => {
    const cookie = await login();
    const ok = await call("/admin/api/tokens", {
      ...form({
        label: "exp",
        providers: "openai",
        token: "with-expiry-token",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    expect(ok.status).toBe(200);
    expect(await getValidated(env.TOKENS, "with-expiry-token")).toMatchObject({
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const bad = await call("/admin/api/tokens", {
      ...form({
        label: "bad-exp",
        providers: "openai",
        token: "bad-expiry-token",
        expiresAt: "not-a-date",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    expect(bad.status).toBe(400);

    // An offset-less value (raw API call bypassing the form) is rejected - it would be
    // read in the runtime's local timezone, not the admin's.
    const bare = await call("/admin/api/tokens", {
      ...form({
        label: "bare-exp",
        providers: "openai",
        token: "bare-expiry-token",
        expiresAt: "2030-01-01T00:00",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    expect(bare.status).toBe(400);
  });

  it("dashboard markup pins the browser-side UTC conversion and the visibility-gated poll", async () => {
    const cookie = await login();
    const page = await (await call("/admin", { headers: { cookie } })).text();
    expect(page).toContain("hx-on::config-request");
    expect(page).toContain("toISOString()");
    expect(page).toContain("every 120s [document.visibilityState==='visible']");
    // htmx delivery is hash-pinned (SRI): the EXACT hash is asserted so an accidental edit
    // to HTMX_SRI (which would make the browser refuse htmx and brick the admin) fails here.
    expect(page).toContain(
      'integrity="sha384-ESlCao+z/oasnu2Uc/5K1LQTI7YCF2KKO4xakCPQCFuiHhCh8Oa/R5NwHY6guZ3m"',
    );
    expect(page).toContain('crossorigin="anonymous"');
    expect(page).toContain('id="flash"');
    expect(page).toContain("hx-on::response-error");
    expect(page).toContain("hx-on::send-error");
  });

  it("rejects a malformed token id on PUT and DELETE", async () => {
    const cookie = await login();
    const put = await call("/admin/api/tokens/not-a-hash", {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: "status=disabled",
    });
    expect(put.status).toBe(400);
    const del = await call("/admin/api/tokens/xyz", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(400);
  });

  it("supports multiple providers from repeated form fields", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: "label=multi&token=multi-tok-token&providers=openai&providers=anthropic",
    });
    expect(await getValidated(env.TOKENS, "multi-tok-token")).toMatchObject({
      providers: ["openai", "anthropic"],
    });
  });
});

describe("admin session verification", () => {
  const hmacHex = async (data: string): Promise<string> => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-admin-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data),
    );
    return [...new Uint8Array(sig)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  it("accepts a hand-minted valid cookie (sanity for the negative cases)", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await call("/admin/api/tokens", {
      headers: { cookie: `cm_admin=${ts}.${await hmacHex(ts)}` },
    });
    expect(res.status).toBe(200);
  });
  it("rejects a garbage cookie", async () => {
    const res = await call("/admin/api/tokens", {
      headers: { cookie: "cm_admin=123.deadbeef" },
    });
    expect(res.status).toBe(401);
  });
  it("rejects a valid signature with one flipped hex digit", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await hmacHex(ts);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    const res = await call("/admin/api/tokens", {
      headers: { cookie: `cm_admin=${ts}.${flipped}` },
    });
    expect(res.status).toBe(401);
  });
  it("rejects a correctly signed but expired (>24h) timestamp", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 86_401);
    const res = await call("/admin/api/tokens", {
      headers: { cookie: `cm_admin=${ts}.${await hmacHex(ts)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("admin input guards", () => {
  it("429s login when the limiter denies, keyed per client IP", async () => {
    let seenKey = "";
    const limited = {
      ...env,
      LOGIN_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          seenKey = key;
          return { success: false };
        },
      } as unknown as RateLimit,
    };
    const ctx = createExecutionContext();
    const req = form({ password: "test-admin-secret" }) as RequestInit & {
      headers: Record<string, string>;
    };
    req.headers["cf-connecting-ip"] = "203.0.113.9";
    const res = await worker.fetch(
      new Request("https://proxy.example/admin/login", req),
      limited,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(seenKey).toBe("login:203.0.113.9");
  });

  it("400s creation with no providers instead of silently scoping to openai", async () => {
    const cookie = await login();
    const res = await call("/admin/api/tokens", {
      ...form({ label: "np", token: "no-providers-token" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    expect(res.status).toBe(400);
    expect(await getValidated(env.TOKENS, "no-providers-token")).toBeNull();
  });

  it("400s a short custom token and 409s a duplicate (no silent overwrite)", async () => {
    const cookie = await login();
    const hdrs = {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    };
    const short = await call("/admin/api/tokens", {
      ...form({ label: "s", providers: "openai", token: "tiny" }),
      headers: hdrs,
    });
    expect(short.status).toBe(400);

    const first = await call("/admin/api/tokens", {
      ...form({ label: "dup1", providers: "openai", token: "duplicate-token" }),
      headers: hdrs,
    });
    expect(first.status).toBe(200);
    const dup = await call("/admin/api/tokens", {
      ...form({ label: "dup2", providers: "openai", token: "duplicate-token" }),
      headers: hdrs,
    });
    expect(dup.status).toBe(409);
    // the original record survives untouched
    expect(await getValidated(env.TOKENS, "duplicate-token")).toMatchObject({
      label: "dup1",
    });
  });

  it("400s a malformed status instead of defaulting a disabled token back to active", async () => {
    const cookie = await login();
    const hdrs = {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    };
    await call("/admin/api/tokens", {
      ...form({ label: "w", providers: "openai", token: "whitelist-token" }),
      headers: hdrs,
    });
    const hash = await sha256hex("whitelist-token");
    await call(`/admin/api/tokens/${hash}`, {
      method: "PUT",
      headers: hdrs,
      body: "status=disabled",
    });
    const bad = await call(`/admin/api/tokens/${hash}`, {
      method: "PUT",
      headers: hdrs,
      body: "status=banana",
    });
    expect(bad.status).toBe(400);
    expect(await getValidated(env.TOKENS, "whitelist-token")).toBeNull(); // still disabled
  });

  it("created notice carries the copy button and per-provider base URLs", async () => {
    const cookie = await login();
    const res = await call("/admin/api/tokens", {
      ...form({
        label: "n",
        providers: "openai",
        token: "notice-test-token",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const body = await res.text();
    expect(body).toContain("notice-test-token");
    expect(body).toContain("copy token");
    expect(body).toContain("https://proxy.example/v1");

    // a gemini-scoped token shows BOTH wirings: native GenAI (bare origin) + OpenAI-SDK compat
    const gem = await call("/admin/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: "label=g&token=notice-gem-token&providers=gemini",
    });
    const gemBody = await gem.text();
    expect(gemBody).toContain("https://proxy.example/v1beta/openai");
  });
});
