import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createToken,
  deleteToken,
  generateToken,
  getValidated,
  listTokens,
  sha256hex,
  touchLastUsed,
  updateToken,
} from "../src/tokens";

describe("sha256hex", () => {
  it("produces a 64-char hex digest", async () => {
    expect(await sha256hex("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is deterministic", async () => {
    expect(await sha256hex("x")).toBe(await sha256hex("x"));
  });
});

describe("generateToken", () => {
  it("has the ptk_ prefix and a url-safe body", () => {
    expect(generateToken()).toMatch(/^ptk_[A-Za-z0-9_-]{32,}$/);
  });
  it("is unique across calls", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("createToken + getValidated", () => {
  it("stores by hash and validates the plaintext token", async () => {
    const { token, meta } = await createToken(env.TOKENS, {
      label: "alice",
      providers: ["openai"],
    });
    expect(token).toMatch(/^ptk_/);
    expect(meta.last4).toBe(token.slice(-4));
    const got = await getValidated(env.TOKENS, token);
    expect(got?.label).toBe("alice");
    expect(got?.providers).toEqual(["openai"]);
    expect(got?.status).toBe("active");
  });
  it("accepts a custom admin-typed token", async () => {
    const { token } = await createToken(env.TOKENS, {
      label: "bob",
      providers: ["anthropic"],
      token: "my-code",
    });
    expect(token).toBe("my-code");
    expect((await getValidated(env.TOKENS, "my-code"))?.label).toBe("bob");
  });
  it("returns null for an unknown token", async () => {
    expect(await getValidated(env.TOKENS, "nope-unknown")).toBeNull();
  });
  it("returns null for a disabled token", async () => {
    const { token, hash } = await createToken(env.TOKENS, {
      label: "c",
      providers: ["gemini"],
    });
    await updateToken(env.TOKENS, hash, { status: "disabled" });
    expect(await getValidated(env.TOKENS, token)).toBeNull();
  });
  it("never stores the plaintext token in the KV value", async () => {
    const { token, hash } = await createToken(env.TOKENS, {
      label: "d",
      providers: ["openai"],
    });
    const raw = await env.TOKENS.get(hash);
    expect(raw).not.toContain(token);
  });
});

describe("listTokens / updateToken / deleteToken", () => {
  it("lists created tokens by hash with metadata", async () => {
    await createToken(env.TOKENS, {
      label: "L1",
      providers: ["openai"],
      token: "list-t1",
    });
    const row = (await listTokens(env.TOKENS)).find((r) => r.label === "L1");
    expect(row?.hash).toBe(await sha256hex("list-t1"));
  });
  it("updates label and providers", async () => {
    const { hash } = await createToken(env.TOKENS, {
      label: "old",
      providers: ["openai"],
      token: "upd-t",
    });
    const updated = await updateToken(env.TOKENS, hash, {
      label: "new",
      providers: ["openai", "anthropic"],
    });
    expect(updated?.label).toBe("new");
    expect(updated?.providers).toEqual(["openai", "anthropic"]);
  });
  it("deletes a token", async () => {
    const { token, hash } = await createToken(env.TOKENS, {
      label: "del",
      providers: ["openai"],
      token: "del-t",
    });
    await deleteToken(env.TOKENS, hash);
    expect(await getValidated(env.TOKENS, token)).toBeNull();
  });
});

describe("touchLastUsed", () => {
  it("sets lastUsed without clobbering other fields", async () => {
    const { hash } = await createToken(env.TOKENS, {
      label: "tu",
      providers: ["openai"],
      token: "tu-t",
    });
    await touchLastUsed(env.TOKENS, hash);
    const row = (await listTokens(env.TOKENS)).find((r) => r.hash === hash);
    expect(row?.lastUsed).toBeTruthy();
    expect(row?.label).toBe("tu");
  });

  it("writes at most once per UTC day per token", async () => {
    const { hash } = await createToken(env.TOKENS, {
      label: "throttle",
      providers: ["openai"],
      token: "throttle-t",
    });
    await touchLastUsed(env.TOKENS, hash);
    expect(await env.TOKENS.get(`${hash}:lu`)).toBeTruthy();
    // a same-day re-touch must not rewrite the deleted stamp
    await env.TOKENS.delete(`${hash}:lu`);
    await touchLastUsed(env.TOKENS, hash);
    expect(await env.TOKENS.get(`${hash}:lu`)).toBeNull();
  });

  it("does not resurrect a disabled token when lastUsed is stamped", async () => {
    const { token, hash } = await createToken(env.TOKENS, {
      label: "rev",
      providers: ["openai"],
      token: "to-revoke",
    });
    await updateToken(env.TOKENS, hash, { status: "disabled" });
    await touchLastUsed(env.TOKENS, hash); // must not re-enable the revoked token
    expect(await getValidated(env.TOKENS, token)).toBeNull();
  });
});

describe("expiry (getValidatedByHash via getValidated)", () => {
  const mk = (token: string, expiresAt?: string) =>
    createToken(env.TOKENS, {
      label: token,
      providers: ["openai"],
      token,
      expiresAt,
    });

  it("absent expiresAt stays valid", async () => {
    const { token } = await mk("exp-none");
    expect(await getValidated(env.TOKENS, token)).not.toBeNull();
  });
  it("future expiresAt is valid", async () => {
    const { token } = await mk(
      "exp-future",
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    expect(await getValidated(env.TOKENS, token)).not.toBeNull();
  });
  it("past expiresAt is rejected", async () => {
    const { token } = await mk(
      "exp-past",
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(await getValidated(env.TOKENS, token)).toBeNull();
  });
  it("malformed expiresAt is rejected (fail-closed)", async () => {
    const { token } = await mk("exp-bad", "not-a-date");
    expect(await getValidated(env.TOKENS, token)).toBeNull();
  });
});
