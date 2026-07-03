import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken } from "../src/tokens";
import {
  extractWsToken,
  forwardCloseCode,
  handleWsProxy,
  prepareWsUpstream,
  routeWsProvider,
} from "../src/ws";

// A fake upstream 101 carrying a live WebSocket, so handleWsProxy can accept + pipe it.
function ws101(): Response {
  const [upstream] = Object.values(new WebSocketPair());
  return new Response(null, { status: 101, webSocket: upstream });
}
const geo403 = () =>
  new Response(
    JSON.stringify({ error: { code: "unsupported_country_region_territory" } }),
    { status: 403 },
  );

let captured: Request | null;
let upstreamReply: () => Response;

beforeEach(() => {
  captured = null;
  upstreamReply = ws101;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = input instanceof Request ? input : new Request(input, init);
      return upstreamReply();
    },
  );
});
afterEach(() => vi.restoreAllMocks());

async function callWs(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await handleWsProxy(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const seed = (
  token: string,
  providers: ("openai" | "anthropic" | "gemini")[],
) => createToken(env.TOKENS, { label: token, providers, token });

describe("WS auth-slot extraction", () => {
  it("reads the token smuggled in the openai-insecure-api-key subprotocol", () => {
    const req = new Request("https://proxy.example/v1/realtime?model=m", {
      headers: {
        "sec-websocket-protocol":
          "realtime, openai-insecure-api-key.tk-123, openai-beta.realtime-v1",
      },
    });
    const url = new URL(req.url);
    expect(extractWsToken(req, url)).toBe("tk-123");
    expect(routeWsProvider(req, url)).toBe("openai");
  });

  it("falls back to the header and query slots", () => {
    const bearer = new Request("https://p/v1/responses", {
      headers: { authorization: "Bearer tk-h" },
    });
    expect(extractWsToken(bearer, new URL(bearer.url))).toBe("tk-h");
    expect(routeWsProvider(bearer, new URL(bearer.url))).toBe("openai");

    const query = new Request(
      "https://p/ws/Service.BidiGenerateContent?key=tk-q",
    );
    expect(extractWsToken(query, new URL(query.url))).toBe("tk-q");
    expect(routeWsProvider(query, new URL(query.url))).toBe("gemini");
  });
});

describe("prepareWsUpstream (pure auth swap)", () => {
  it("openai: real key as Bearer, host rewritten, path + query kept, scheme stays https", () => {
    const req = new Request(
      "https://proxy.example/v1/realtime?model=gpt-realtime-2",
      { headers: { authorization: "Bearer tk" } },
    );
    const url = new URL(req.url);
    const { target, headers } = prepareWsUpstream(
      req,
      url,
      "openai",
      "REAL",
      env,
    );
    const u = new URL(target);
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("api.openai.com");
    expect(u.pathname).toBe("/v1/realtime");
    expect(u.searchParams.get("model")).toBe("gpt-realtime-2");
    expect(headers.get("authorization")).toBe("Bearer REAL");
  });

  it("openai subprotocol: drops the key entry, keeps realtime, sets Bearer", () => {
    const req = new Request("https://proxy.example/v1/realtime", {
      headers: {
        "sec-websocket-protocol":
          "realtime, openai-insecure-api-key.tk, openai-beta.realtime-v1",
      },
    });
    const { headers } = prepareWsUpstream(
      req,
      new URL(req.url),
      "openai",
      "REAL",
      env,
    );
    expect(headers.get("authorization")).toBe("Bearer REAL");
    const proto = headers.get("sec-websocket-protocol") ?? "";
    expect(proto).toContain("realtime");
    expect(proto).toContain("openai-beta.realtime-v1");
    expect(proto).not.toContain("openai-insecure-api-key");
    expect(proto).not.toContain("tk");
  });

  it("gemini: real key in ?key=, no Authorization header", () => {
    const req = new Request(
      "https://proxy.example/ws/Service.BidiGenerateContent?key=tk",
    );
    const url = new URL(req.url);
    const { target, headers } = prepareWsUpstream(
      req,
      url,
      "gemini",
      "REAL",
      env,
    );
    const u = new URL(target);
    expect(u.hostname).toBe("generativelanguage.googleapis.com");
    expect(u.searchParams.get("key")).toBe("REAL");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();
  });
});

describe("handleWsProxy: validation (upstream never opened)", () => {
  it("401 when no token is present", async () => {
    const res = await callWs(new Request("https://proxy.example/v1/realtime"));
    expect(res.status).toBe(401);
    expect(captured).toBeNull();
  });
  it("401 for an unknown token", async () => {
    const res = await callWs(
      new Request("https://proxy.example/v1/realtime", {
        headers: { authorization: "Bearer ghost" },
      }),
    );
    expect(res.status).toBe(401);
    expect(captured).toBeNull();
  });
  it("403 when the token is not scoped to the provider", async () => {
    await seed("tk-gem-only", ["gemini"]);
    const res = await callWs(
      new Request("https://proxy.example/v1/realtime", {
        headers: { authorization: "Bearer tk-gem-only" },
      }),
    );
    expect(res.status).toBe(403);
    expect(captured).toBeNull();
  });
});

describe("handleWsProxy: auth swap + upgrade", () => {
  it("openai Bearer (/v1/responses): swaps in the real key and returns 101", async () => {
    await seed("tk-oai", ["openai"]);
    const res = await callWs(
      new Request("https://proxy.example/v1/responses", {
        headers: { authorization: "Bearer tk-oai" },
      }),
    );
    expect(res.status).toBe(101);
    const u = new URL(captured!.url);
    expect(u.hostname).toBe("api.openai.com");
    expect(u.pathname).toBe("/v1/responses");
    expect(captured!.headers.get("authorization")).toBe(
      "Bearer real-openai-key-FAKE",
    );
  });

  it("openai subprotocol smuggling: swaps to Bearer, strips the key subprotocol", async () => {
    await seed("tk-rt", ["openai"]);
    const res = await callWs(
      new Request("https://proxy.example/v1/realtime?model=gpt-realtime-2", {
        headers: {
          "sec-websocket-protocol": "realtime, openai-insecure-api-key.tk-rt",
        },
      }),
    );
    expect(res.status).toBe(101);
    expect(captured!.headers.get("authorization")).toBe(
      "Bearer real-openai-key-FAKE",
    );
    const proto = captured!.headers.get("sec-websocket-protocol") ?? "";
    expect(proto).toContain("realtime");
    expect(proto).not.toContain("openai-insecure-api-key");
  });

  it("gemini ?key=: swaps the query key, sets no Authorization header", async () => {
    await seed("tk-gem", ["gemini"]);
    const res = await callWs(
      new Request(
        "https://proxy.example/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=tk-gem",
      ),
    );
    expect(res.status).toBe(101);
    const u = new URL(captured!.url);
    expect(u.hostname).toBe("generativelanguage.googleapis.com");
    expect(u.searchParams.get("key")).toBe("real-gemini-key-FAKE");
    expect(captured!.headers.get("authorization")).toBeNull();
  });
});

describe("handleWsProxy: security invariant", () => {
  it("never forwards the proxy token upstream in any slot", async () => {
    await seed("SECRET-WS", ["openai"]);
    await callWs(
      new Request("https://proxy.example/v1/realtime", {
        headers: {
          "sec-websocket-protocol":
            "realtime, openai-insecure-api-key.SECRET-WS",
        },
      }),
    );
    const blob = [
      captured!.url,
      captured!.headers.get("authorization"),
      captured!.headers.get("sec-websocket-protocol"),
    ].join("|");
    expect(blob).not.toContain("SECRET-WS");
  });
});

describe("handleWsProxy: OpenAI geo-403 fallback via the egress DO", () => {
  const realEgress = env.US_EGRESS;
  let egressCalls: Request[];
  afterEach(() => {
    (env as { US_EGRESS: typeof realEgress }).US_EGRESS = realEgress;
  });
  function fakeEgress(reply: () => Response) {
    egressCalls = [];
    const stub = {
      fetch: async (r: Request) => {
        egressCalls.push(r);
        return reply();
      },
    };
    (env as { US_EGRESS: unknown }).US_EGRESS = {
      idFromName: () => ({}),
      get: () => stub,
    };
  }

  it("retries the upgrade through the egress DO on a geo-403, with the real key", async () => {
    await seed("tk-geo", ["openai"]);
    fakeEgress(ws101);
    upstreamReply = geo403;
    const res = await callWs(
      new Request("https://proxy.example/v1/responses", {
        headers: { authorization: "Bearer tk-geo" },
      }),
    );
    expect(res.status).toBe(101);
    expect(egressCalls.length).toBe(1);
    expect(new URL(egressCalls[0].url).hostname).toBe("api.openai.com");
    expect(egressCalls[0].headers.get("authorization")).toBe(
      "Bearer real-openai-key-FAKE",
    );
  });

  it("never routes gemini through the egress DO (403 surfaces straight through)", async () => {
    await seed("tk-gem2", ["gemini"]);
    fakeEgress(ws101);
    upstreamReply = geo403;
    const res = await callWs(
      new Request(
        "https://proxy.example/ws/Service.BidiGenerateContent?key=tk-gem2",
      ),
    );
    expect(res.status).toBe(403);
    expect(egressCalls.length).toBe(0);
  });
});

describe("handleWsProxy: rate limiting", () => {
  const real = (env as { RATE_LIMITER?: unknown }).RATE_LIMITER;
  afterEach(() => {
    (env as { RATE_LIMITER?: unknown }).RATE_LIMITER = real;
  });
  const setLimiter = (
    limit: (o: { key: string }) => Promise<{ success: boolean }>,
  ) => {
    (env as { RATE_LIMITER: unknown }).RATE_LIMITER = { limit };
  };

  it("429s with Retry-After when denied, without opening the upstream", async () => {
    await seed("tk-ws-rl", ["openai"]);
    setLimiter(async () => ({ success: false }));
    const res = await callWs(
      new Request("https://proxy.example/v1/responses", {
        headers: { authorization: "Bearer tk-ws-rl" },
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(captured).toBeNull();
  });

  it("fails open (101) when the limiter throws", async () => {
    await seed("tk-ws-err", ["openai"]);
    setLimiter(async () => {
      throw new Error("limiter down");
    });
    const res = await callWs(
      new Request("https://proxy.example/v1/responses", {
        headers: { authorization: "Bearer tk-ws-err" },
      }),
    );
    expect(res.status).toBe(101);
  });
});

describe("handleWsProxy: upstream connect failure", () => {
  it("returns 502 when the upstream connect throws (no propagation)", async () => {
    await seed("tk-boom", ["openai"]);
    upstreamReply = () => {
      throw new Error("connect refused");
    };
    const res = await callWs(
      new Request("https://proxy.example/v1/responses", {
        headers: { authorization: "Bearer tk-boom" },
      }),
    );
    expect(res.status).toBe(502);
  });
});

describe("forwardCloseCode (close-code sanitization)", () => {
  it("passes through normal application codes (1000-4999, not reserved)", () => {
    expect(forwardCloseCode(1000)).toBe(1000);
    expect(forwardCloseCode(1011)).toBe(1011);
    expect(forwardCloseCode(3000)).toBe(3000);
    expect(forwardCloseCode(4999)).toBe(4999);
  });
  it("downgrades reserved/abnormal codes to a bare close (null)", () => {
    for (const c of [1004, 1005, 1006, 1015])
      expect(forwardCloseCode(c)).toBeNull();
  });
  it("downgrades out-of-range codes to a bare close (null)", () => {
    expect(forwardCloseCode(999)).toBeNull();
    expect(forwardCloseCode(5000)).toBeNull();
    expect(forwardCloseCode(0)).toBeNull();
  });
});
