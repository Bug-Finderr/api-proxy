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
    expect(await res.text()).toContain("password");
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
      ...form({ label: "alice", providers: "openai", token: "compat-xyz" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    expect(res.status).toBe(200);
    const meta = await getValidated(env.TOKENS, "compat-xyz");
    expect(meta?.label).toBe("alice");
    expect(meta?.providers).toEqual(["openai"]);
  });

  it("lists tokens by label", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form({ label: "bob", providers: "anthropic", token: "list-bob" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const res = await call("/admin/api/tokens", { headers: { cookie } });
    expect(await res.text()).toContain("bob");
  });

  it("disables a token so the proxy rejects it", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form({ label: "c", providers: "gemini", token: "to-disable" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const hash = await sha256hex("to-disable");
    const upd = await call(`/admin/api/tokens/${hash}`, {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ status: "disabled" }).toString(),
    });
    expect(upd.status).toBe(200);
    expect(await getValidated(env.TOKENS, "to-disable")).toBeNull();
  });

  it("deletes a token", async () => {
    const cookie = await login();
    await call("/admin/api/tokens", {
      ...form({ label: "d", providers: "openai", token: "to-delete" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const hash = await sha256hex("to-delete");
    const del = await call(`/admin/api/tokens/${hash}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);
    expect(await getValidated(env.TOKENS, "to-delete")).toBeNull();
  });

  it("stores a UTC ISO expiresAt and 400s an unparseable one", async () => {
    const cookie = await login();
    const ok = await call("/admin/api/tokens", {
      ...form({
        label: "exp",
        providers: "openai",
        token: "with-expiry",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    expect(ok.status).toBe(200);
    const meta = await getValidated(env.TOKENS, "with-expiry");
    expect(meta?.expiresAt).toBe("2030-01-01T00:00:00.000Z");

    const bad = await call("/admin/api/tokens", {
      ...form({
        label: "bad-exp",
        providers: "openai",
        token: "bad-expiry",
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
        token: "bare-expiry",
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
      body: "label=multi&token=multi-tok&providers=openai&providers=anthropic",
    });
    const meta = await getValidated(env.TOKENS, "multi-tok");
    expect(meta?.providers).toEqual(["openai", "anthropic"]);
  });
});
