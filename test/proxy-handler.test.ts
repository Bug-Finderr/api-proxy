import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createToken, updateToken } from "../src/tokens";

let captured: Request | null;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captured = null;
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = input instanceof Request ? input : new Request(input, init);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
});
afterEach(() => vi.restoreAllMocks());

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const seed = (
  token: string,
  providers: ("openai" | "anthropic" | "gemini")[],
) => createToken(env.TOKENS, { label: token, providers, token });

describe("proxy routing + key swap", () => {
  it("forwards a valid OpenAI request with the real key swapped in", async () => {
    await seed("tk-oai", ["openai"]);
    const res = await call(
      new Request("https://proxy.example/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer tk-oai",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-x", messages: [] }),
      }),
    );
    expect(res.status).toBe(200);
    const u = new URL(captured!.url);
    expect(u.hostname).toBe("api.openai.com");
    expect(u.pathname).toBe("/v1/chat/completions");
    expect(captured!.headers.get("authorization")).toBe(
      "Bearer real-openai-key-FAKE",
    );
  });

  it("forwards a valid Anthropic request swapping x-api-key and passing other headers through", async () => {
    await seed("tk-anth", ["anthropic"]);
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-anth", "anthropic-version": "2023-06-01" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(new URL(captured!.url).hostname).toBe("api.anthropic.com");
    expect(captured!.headers.get("x-api-key")).toBe("real-anthropic-key-FAKE");
    expect(captured!.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("forwards a Gemini request swapping x-goog-api-key, dropping ?key=, preserving other query", async () => {
    await seed("tk-gem", ["gemini"]);
    const res = await call(
      new Request(
        "https://proxy.example/v1beta/models/g:generateContent?key=tk-gem&alt=sse",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(res.status).toBe(200);
    const u = new URL(captured!.url);
    expect(u.hostname).toBe("generativelanguage.googleapis.com");
    expect(u.searchParams.get("key")).toBeNull();
    expect(u.searchParams.get("alt")).toBe("sse");
    expect(captured!.headers.get("x-goog-api-key")).toBe(
      "real-gemini-key-FAKE",
    );
  });

  it("routes the Gemini OpenAI-compat path via bearer to the gemini upstream", async () => {
    await seed("tk-gem2", ["gemini"]);
    const res = await call(
      new Request("https://proxy.example/v1beta/openai/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer tk-gem2" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(new URL(captured!.url).hostname).toBe(
      "generativelanguage.googleapis.com",
    );
    expect(captured!.headers.get("authorization")).toBe(
      "Bearer real-gemini-key-FAKE",
    );
  });
});

describe("auth failures (upstream never called)", () => {
  it("401 when no token is present", async () => {
    const res = await call(
      new Request("https://proxy.example/v1/chat/completions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect(captured).toBeNull();
  });
  it("401 for an unknown token", async () => {
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "ghost" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect(captured).toBeNull();
  });
  it("401 for a disabled token", async () => {
    const { hash } = await createToken(env.TOKENS, {
      label: "d",
      providers: ["openai"],
      token: "tk-disabled",
    });
    await updateToken(env.TOKENS, hash, { status: "disabled" });
    const res = await call(
      new Request("https://proxy.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer tk-disabled" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect(captured).toBeNull();
  });
  it("403 when the token is not scoped to the requested provider", async () => {
    await createToken(env.TOKENS, {
      label: "s",
      providers: ["openai"],
      token: "tk-oai-only",
    });
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-oai-only" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(captured).toBeNull();
  });
});

describe("security invariant", () => {
  it("never forwards the proxy token upstream in any slot (headers or URL)", async () => {
    await createToken(env.TOKENS, {
      label: "sec",
      providers: ["openai"],
      token: "SECRET-TOKEN",
    });
    // Dual-slot client: header auth plus a belt-and-braces ?key= in the URL.
    await call(
      new Request(
        "https://proxy.example/v1/chat/completions?key=SECRET-TOKEN",
        {
          method: "POST",
          headers: { authorization: "Bearer SECRET-TOKEN" },
          body: "{}",
        },
      ),
    );
    const slots = [
      captured!.url,
      captured!.headers.get("authorization"),
      captured!.headers.get("x-api-key"),
      captured!.headers.get("x-goog-api-key"),
    ].join("|");
    expect(slots).not.toContain("SECRET-TOKEN");
  });
});

describe("token store outage", () => {
  it("503s when KV rejects instead of surfacing an unhandled exception", async () => {
    const broken = {
      ...env,
      TOKENS: {
        get: () => Promise.reject(new Error("kv down")),
      } as unknown as KVNamespace,
    };
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://proxy.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer whatever" },
        body: "{}",
      }),
      broken,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
    expect(captured).toBeNull();
  });
});

describe("OpenAI geo-403 fallback via the US egress DO", () => {
  const realEgress = env.US_EGRESS;
  let egressCalls: Request[];
  afterEach(() => {
    (env as { US_EGRESS: typeof realEgress }).US_EGRESS = realEgress;
  });

  // Replace the DO namespace with a fake whose stub.fetch records the request and returns 200.
  function fakeEgress() {
    egressCalls = [];
    const stub = {
      fetch: async (r: Request) => {
        egressCalls.push(r);
        return new Response(JSON.stringify({ ok: "via-egress" }), {
          status: 200,
        });
      },
    };
    (env as { US_EGRESS: unknown }).US_EGRESS = {
      idFromName: () => ({}),
      get: () => stub,
    };
  }

  const geo403 = () =>
    new Response(
      JSON.stringify({
        error: { code: "unsupported_country_region_territory" },
      }),
      { status: 403 },
    );

  it("retries through the egress DO when OpenAI returns a geo-403, with the real key", async () => {
    await seed("tk-geo", ["openai"]);
    fakeEgress();
    fetchSpy.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = input instanceof Request ? input : new Request(input, init);
        return geo403();
      },
    );
    const res = await call(
      new Request("https://proxy.example/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer tk-geo",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-x",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: "via-egress" });
    expect(egressCalls.length).toBe(1);
    const sent = egressCalls[0];
    expect(new URL(sent.url).hostname).toBe("api.openai.com");
    expect(sent.headers.get("authorization")).toBe(
      "Bearer real-openai-key-FAKE",
    );
    expect(await sent.text()).toContain("hi"); // buffered body survived to the retry
  });

  it("does NOT retry on a non-geo 403 (passes it through)", async () => {
    await seed("tk-403", ["openai"]);
    fakeEgress();
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), {
          status: 403,
        }),
    );
    const res = await call(
      new Request("https://proxy.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer tk-403" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(egressCalls.length).toBe(0);
  });

  it("never routes non-OpenAI providers through the egress DO", async () => {
    await seed("tk-anth-geo", ["anthropic"]);
    fakeEgress();
    fetchSpy.mockImplementation(async () => geo403());
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-anth-geo" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403); // anthropic 403 passes straight through
    expect(egressCalls.length).toBe(0);
  });
});

describe("SSE passthrough", () => {
  it("streams text/event-stream chunks through without buffering", async () => {
    await createToken(env.TOKENS, {
      label: "sse",
      providers: ["openai"],
      token: "tk-sse",
    });
    fetchSpy.mockImplementation(async () => {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode("data: a\n\n"));
          c.enqueue(enc.encode("data: b\n\n"));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const res = await call(
      new Request("https://proxy.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer tk-sse" },
        body: "{}",
      }),
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: a");
    expect(text).toContain("[DONE]");
  });
});

describe("CORS", () => {
  it("answers the preflight OPTIONS without auth and never calls upstream", async () => {
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example",
          "access-control-request-headers": "x-api-key, content-type",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "x-api-key, content-type",
    );
    expect(res.headers.get("access-control-max-age")).toBe("86400");
    expect(captured).toBeNull();
  });

  it("reflects Origin and exposes the Gemini upload headers on a proxied response", async () => {
    await seed("tk-cors", ["anthropic"]);
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-cors", origin: "https://app.example" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "x-goog-upload-url",
    );
  });

  it("omits CORS headers when no Origin is sent (server-side callers)", async () => {
    await seed("tk-nocors", ["anthropic"]);
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-nocors" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("rate limiting", () => {
  const real = (env as { RATE_LIMITER?: unknown }).RATE_LIMITER;
  afterEach(() => {
    (env as { RATE_LIMITER?: unknown }).RATE_LIMITER = real;
  });
  const setLimiter = (
    limit: (o: { key: string }) => Promise<{ success: boolean }>,
  ) => {
    (env as { RATE_LIMITER: unknown }).RATE_LIMITER = { limit };
  };

  it("429s with Retry-After when the limiter denies, without calling upstream", async () => {
    await seed("tk-rl", ["anthropic"]);
    setLimiter(async () => ({ success: false }));
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-rl" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(captured).toBeNull();
  });

  it("forwards when the limiter allows", async () => {
    await seed("tk-rl-ok", ["anthropic"]);
    setLimiter(async () => ({ success: true }));
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-rl-ok" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("fails open (forwards) when the limiter throws", async () => {
    await seed("tk-rl-err", ["anthropic"]);
    setLimiter(async () => {
      throw new Error("limiter down");
    });
    const res = await call(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "tk-rl-err" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });
});
