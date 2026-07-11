import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256hex } from "../src/tokens";
import { getValidated } from "./helpers";

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

const form = (data: Record<string, string>, cookie?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(cookie && { cookie }),
  },
  body: new URLSearchParams(data).toString(),
});

const put = (path: string, data: Record<string, string>, cookie: string) =>
  call(path, { ...form(data, cookie), method: "PUT" });

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
    expect(page).toContain("login-error");
    expect(page).toContain("hx-on::response-error");
  });
  it("sends security headers on every admin response", async () => {
    const res = await call("/admin");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(
      "script-src 'unsafe-eval' https://unpkg.com/htmx.org@2.0.10/dist/htmx.min.js",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toBeTruthy();
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
      ...form(
        {
          label: "alice",
          providers: "openai",
          token: "compat-xyz-token",
        },
        cookie,
      ),
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
      ...form(
        {
          label: "bob",
          providers: "anthropic",
          token: "list-bob-token",
        },
        cookie,
      ),
    });
    const res = await call("/admin/api/tokens", { headers: { cookie } });
    expect(await res.text()).toContain("bob");
  });

  it("disables a token so the proxy rejects it", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form(
        { label: "c", providers: "gemini", token: "to-disable-token" },
        cookie,
      ),
    });
    const hash = await sha256hex("to-disable-token");
    const upd = await put(
      `/admin/api/tokens/${hash}`,
      { status: "disabled" },
      cookie,
    );
    expect(upd.status).toBe(200);
    expect(await getValidated(env.TOKENS, "to-disable-token")).toBeNull();
  });

  it("deletes a token", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form(
        { label: "d", providers: "openai", token: "to-delete-token" },
        cookie,
      ),
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
      ...form(
        {
          label: "exp",
          providers: "openai",
          token: "with-expiry-token",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        cookie,
      ),
    });
    expect(ok.status).toBe(200);
    expect(await getValidated(env.TOKENS, "with-expiry-token")).toMatchObject({
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const table = await (
      await call("/admin/api/tokens", { headers: { cookie } })
    ).text();
    expect(table).toContain('datetime="2030-01-01T00:00:00.000Z"');
    expect(table).toContain("2030-01-01 00:00 UTC");
    // Each row carries a click-to-edit expiry editor (behavior is delegated at the body).
    expect(table).toContain('hx-trigger="commit"');
    expect(table).toContain('data-iso="2030-01-01T00:00:00.000Z"');
    expect(table).toContain('hx-indicator="closest tr"');

    const bad = await call("/admin/api/tokens", {
      ...form(
        {
          label: "bad-exp",
          providers: "openai",
          token: "bad-expiry-token",
          expiresAt: "not-a-date",
        },
        cookie,
      ),
    });
    expect(bad.status).toBe(400);

    // offset-less values (raw API, bypassing the form) would parse in the runtime's timezone, not the admin's
    const bare = await call("/admin/api/tokens", {
      ...form(
        {
          label: "bare-exp",
          providers: "openai",
          token: "bare-expiry-token",
          expiresAt: "2030-01-01T00:00",
        },
        cookie,
      ),
    });
    expect(bare.status).toBe(400);
  });

  it("edits expiry via PUT so the proxy honors it, and an empty value clears it", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form(
        { label: "ee", providers: "openai", token: "edit-expiry-token" },
        cookie,
      ),
    });
    const hash = await sha256hex("edit-expiry-token");
    await env.TOKENS.put(`${hash}:lu`, "2026-07-01T00:00:00.000Z");

    const past = await put(
      `/admin/api/tokens/${hash}`,
      { expiresAt: "2020-01-01T00:00:00.000Z" },
      cookie,
    );
    expect(past.status).toBe(200);
    const row = await past.text();
    expect(row).toContain('class="edit danger"');
    // The swapped row must keep the separately stored lastUsed, not reset it to "never".
    expect(row).toContain('datetime="2026-07-01T00:00:00.000Z"');
    expect(await getValidated(env.TOKENS, "edit-expiry-token")).toBe("expired");

    const cleared = await put(
      `/admin/api/tokens/${hash}`,
      { expiresAt: "" },
      cookie,
    );
    expect(cleared.status).toBe(200);
    // Clearing drops the key from the stored JSON entirely (never expires).
    expect(await env.TOKENS.get(hash)).not.toContain("expiresAt");
    expect(await getValidated(env.TOKENS, "edit-expiry-token")).toMatchObject({
      status: "active",
    });
  });

  it("keeps a token disabled when an expiry edit races the disable", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form(
        { label: "race", providers: "openai", token: "race-check-token" },
        cookie,
      ),
    });
    const hash = await sha256hex("race-check-token");
    for (let i = 0; i < 5; i++) {
      await put(`/admin/api/tokens/${hash}`, { status: "active" }, cookie);
      // Concurrent handlers interleave at KV awaits; the writer DO must serialize
      // the merges so the stale-read expiry patch cannot resurrect the disable.
      await Promise.all([
        put(`/admin/api/tokens/${hash}`, { status: "disabled" }, cookie),
        put(
          `/admin/api/tokens/${hash}`,
          { expiresAt: "2040-01-01T00:00:00.000Z" },
          cookie,
        ),
      ]);
      expect(await getValidated(env.TOKENS, "race-check-token")).toBeNull();
    }
  });

  it("merges from the writer's own storage, not a stale KV echo", async () => {
    const cookie = await login();
    const res = await call("/admin/api/tokens", {
      ...form(
        { label: "stale", providers: "openai", token: "stale-echo-token" },
        cookie,
      ),
    });
    expect(res.status).toBe(200);
    const hash = await sha256hex("stale-echo-token");
    await put(`/admin/api/tokens/${hash}`, { status: "disabled" }, cookie);
    // Simulate KV serving a stale pre-disable record (KV has no read-your-write guarantee).
    const stale = JSON.parse((await env.TOKENS.get(hash))!);
    await env.TOKENS.put(hash, JSON.stringify({ ...stale, status: "active" }));
    await put(
      `/admin/api/tokens/${hash}`,
      { expiresAt: "2040-01-01T00:00:00.000Z" },
      cookie,
    );
    expect(await getValidated(env.TOKENS, "stale-echo-token")).toBeNull();
  });

  it("does not resurrect a deleted token from a stale KV echo (tombstone)", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form(
        { label: "tomb", providers: "openai", token: "tombstone-token" },
        cookie,
      ),
    });
    const hash = await sha256hex("tombstone-token");
    const record = (await env.TOKENS.get(hash))!;
    await call(`/admin/api/tokens/${hash}`, {
      method: "DELETE",
      headers: { cookie },
    });
    // The stale record resurfaces after the delete; a patch must not resurrect it.
    await env.TOKENS.put(hash, record);
    const res = await put(
      `/admin/api/tokens/${hash}`,
      { status: "active" },
      cookie,
    );
    expect(res.status).toBe(404);
  });

  it("a deleted then recreated token is editable again (tombstone cleared)", async () => {
    const cookie = await login();
    const mk = () =>
      call("/admin/api/tokens", {
        ...form(
          { label: "re", providers: "openai", token: "recreate-token" },
          cookie,
        ),
      });
    await mk();
    const hash = await sha256hex("recreate-token");
    await call(`/admin/api/tokens/${hash}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect((await mk()).status).toBe(200);
    const res = await put(
      `/admin/api/tokens/${hash}`,
      { status: "disabled" },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(await getValidated(env.TOKENS, "recreate-token")).toBeNull();
  });

  it("400s an invalid expiry patch and a PUT with nothing to update", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form(
        { label: "eb", providers: "openai", token: "bad-patch-token" },
        cookie,
      ),
    });
    const hash = await sha256hex("bad-patch-token");
    // POST already pins both parseExpiry rejection branches; one case pins the PUT wiring.
    const bad = await put(
      `/admin/api/tokens/${hash}`,
      { expiresAt: "2030-01-01T00:00" },
      cookie,
    );
    expect(bad.status).toBe(400);
    expect((await put(`/admin/api/tokens/${hash}`, {}, cookie)).status).toBe(
      400,
    );
    expect(await getValidated(env.TOKENS, "bad-patch-token")).toMatchObject({
      label: "eb",
    });
  });

  it("dashboard markup pins the browser-side UTC conversion and the visibility-gated poll", async () => {
    const cookie = await login();
    const page = await (await call("/admin", { headers: { cookie } })).text();
    expect(page).toContain(
      "every 120s [document.visibilityState==='visible' && document.activeElement?.type !== 'datetime-local']",
    );
    // Pin the hash so HTMX upgrades must update SRI deliberately.
    expect(page).toContain(
      'integrity="sha384-H5SrcfygHmAuTDZphMHqBJLc3FhssKjG7w/CeCpFReSfwBWDTKpkzPP8c+cLsK+V"',
    );
    expect(page).toContain('crossorigin="anonymous"');
    expect(page).toContain('id="flash"');
    expect(page).toContain("hx-on::response-error");
    expect(page).toContain("hx-on::send-error");
    expect(page).toContain("hx-on::after-settle");
    expect(page).toContain("toLocaleString");
    expect(page).toContain("time[datetime]");
    const addForm = page.match(
      /<form[^>]*hx-post="\/admin\/api\/tokens"[^>]*>/,
    )?.[0];
    expect(addForm).toContain('method="post"');
    expect(addForm).toContain('action="/admin/api/tokens"');
    expect(page).not.toContain("tokens-changed");
    expect(page).toContain("code.copy");
    expect(page).toContain("navigator.clipboard.writeText");
    expect(page).toContain('name="label" placeholder="alice-laptop" required');
    // One body-level converter serves every datetime-local.
    expect(page).toContain("p.expiresAt = new Date(p.expiresAt).toISOString()");
    // Input-time snap: a picker "Today" fill becomes 23:59 in the field; typed times don't match.
    expect(page).toContain("t.value.slice(0, 11) + '23:59'");
    expect(page).toContain(
      "if (!t.closest('#rows')) { t.blur(); try { t.showPicker() } catch {} }",
    );
    // The poll and row mutations share one persistent sync scope (in-flight polls
    // must never overwrite a newer row swap).
    expect(page).toContain('id="tokens" hx-sync="this:drop"');
    const table = await (
      await call("/admin/api/tokens", { headers: { cookie } })
    ).text();
    expect(table).toContain('<tbody id="rows" hx-sync="#tokens:replace">');
    expect(table).toContain('class="empty"');
  });

  it("rejects a missing or blank label", async () => {
    const cookie = await login();
    const res = await call("/admin/api/tokens", {
      ...form({ label: "  ", providers: "openai" }, cookie),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed token id on PUT and DELETE", async () => {
    const cookie = await login();
    const bad = await put(
      "/admin/api/tokens/not-a-hash",
      { status: "disabled" },
      cookie,
    );
    expect(bad.status).toBe(400);
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
  const mint = (ts: string) =>
    serializeSigned("ap_admin", ts, "test-admin-secret");

  it("accepts a hand-minted valid cookie (sanity for the negative cases)", async () => {
    const cookie = await mint(String(Math.floor(Date.now() / 1000)));
    const res = await call("/admin/api/tokens", { headers: { cookie } });
    expect(res.status).toBe(200);
  });
  it("rejects a garbage cookie", async () => {
    const res = await call("/admin/api/tokens", {
      headers: { cookie: "ap_admin=123.deadbeef" },
    });
    expect(res.status).toBe(401);
  });
  it("rejects a tampered timestamp carrying a signature for a different value", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const value = decodeURIComponent(
      (await mint(String(ts))).slice("ap_admin=".length),
    );
    const sig = value.slice(value.lastIndexOf(".") + 1);
    const res = await call("/admin/api/tokens", {
      headers: { cookie: `ap_admin=${encodeURIComponent(`${ts + 1}.${sig}`)}` },
    });
    expect(res.status).toBe(401);
  });
  it("rejects a correctly signed but expired (>24h) timestamp", async () => {
    const cookie = await mint(String(Math.floor(Date.now() / 1000) - 86_401));
    const res = await call("/admin/api/tokens", { headers: { cookie } });
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
      ...form({ label: "np", token: "no-providers-token" }, cookie),
    });
    expect(res.status).toBe(400);
    expect(await getValidated(env.TOKENS, "no-providers-token")).toBeNull();
  });

  it("400s a short custom token and 409s a duplicate (no silent overwrite)", async () => {
    const cookie = await login();
    const short = await call(
      "/admin/api/tokens",
      form({ label: "s", providers: "openai", token: "tiny" }, cookie),
    );
    expect(short.status).toBe(400);

    const first = await call(
      "/admin/api/tokens",
      form(
        { label: "dup1", providers: "openai", token: "duplicate-token" },
        cookie,
      ),
    );
    expect(first.status).toBe(200);
    const dup = await call(
      "/admin/api/tokens",
      form(
        { label: "dup2", providers: "openai", token: "duplicate-token" },
        cookie,
      ),
    );
    expect(dup.status).toBe(409);
    expect(await getValidated(env.TOKENS, "duplicate-token")).toMatchObject({
      label: "dup1",
    });
  });

  it("400s a malformed status instead of defaulting a disabled token back to active", async () => {
    const cookie = await login();
    await call(
      "/admin/api/tokens",
      form(
        { label: "w", providers: "openai", token: "whitelist-token" },
        cookie,
      ),
    );
    const hash = await sha256hex("whitelist-token");
    await put(`/admin/api/tokens/${hash}`, { status: "disabled" }, cookie);
    const bad = await put(
      `/admin/api/tokens/${hash}`,
      { status: "banana" },
      cookie,
    );
    expect(bad.status).toBe(400);
    expect(await getValidated(env.TOKENS, "whitelist-token")).toBeNull();
  });

  it("created notice carries click-to-copy values and per-provider base URLs", async () => {
    const cookie = await login();
    const res = await call("/admin/api/tokens", {
      ...form(
        {
          label: "n",
          providers: "openai",
          token: "notice-test-token",
        },
        cookie,
      ),
    });
    const body = await res.text();
    expect(body).toContain('<code class="mono copy">notice-test-token</code>');
    expect(body).toContain(
      '<code class="mono copy">https://proxy.example/v1</code>',
    );
    expect(body).toContain(`id="tok-${await sha256hex("notice-test-token")}"`);
    expect(body).toContain('hx-swap-oob="afterbegin:#rows"');

    const gem = await call("/admin/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: "label=g&token=notice-gem-token&providers=gemini",
    });
    const gemBody = await gem.text();
    expect(gemBody).toContain("https://proxy.example/v1beta/openai");
  });
});
