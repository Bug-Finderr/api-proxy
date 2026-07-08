// The proxy hot-path. ZERO framework deps - pure functions + a fetch handler.
// MUST NOT import Hono or any admin code.

import { getValidatedByHash, sha256hex, touchLastUsed } from "./tokens";
import type { CoarseProvider, Env, Provider, TokenMetadata } from "./types";
import { rewriteToUpstream } from "./upstreams";

/** Pull the candidate token from whichever auth slot the SDK used. */
export function extractToken(req: Request, url: URL): string | null {
  const h = req.headers;
  const xApiKey = h.get("x-api-key");
  if (xApiKey) return xApiKey;
  const xGoog = h.get("x-goog-api-key");
  if (xGoog) return xGoog;
  const auth = h.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  return url.searchParams.get("key");
}

/** Identify the provider from the auth header it arrived in (+ path for the Gemini OpenAI-compat route). */
export function routeProvider(req: Request, url: URL): Provider | null {
  const h = req.headers;
  if (h.get("x-api-key")) return "anthropic";
  if (h.get("x-goog-api-key")) return "gemini";
  const auth = h.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    return url.pathname.startsWith("/v1beta/openai/")
      ? "gemini-openai"
      : "openai";
  }
  if (url.searchParams.get("key")) return "gemini";
  return null;
}

/** Collapse gemini-openai onto the gemini scope used by token.providers. */
export function coarse(provider: Provider): CoarseProvider {
  return provider === "gemini-openai" ? "gemini" : provider;
}

/** Strip every inbound auth header, then set exactly one with the real key. Security linchpin. */
export function swapAuth(
  headers: Headers,
  provider: Provider,
  realKey: string,
): void {
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("authorization");
  switch (provider) {
    case "openai":
    case "gemini-openai":
      headers.set("authorization", `Bearer ${realKey}`);
      break;
    case "anthropic":
      headers.set("x-api-key", realKey);
      break;
    case "gemini":
      headers.set("x-goog-api-key", realKey);
      break;
  }
}

/** The real upstream key for a provider. */
export function realKeyFor(provider: Provider, env: Env): string {
  switch (coarse(provider)) {
    case "openai":
      return env.OPENAI_API_KEY;
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "gemini":
      return env.GEMINI_API_KEY;
  }
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EGRESS_POOL = 8;

/** OpenAI 403s requests that egress from an unsupported region (e.g. the Hong Kong colo). */
export async function isGeoBlock(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    return (await res.clone().text()).includes(
      "unsupported_country_region_territory",
    );
  } catch {
    return false;
  }
}

/** A North-America-pinned egress stub, so its fetch() leaves from an OpenAI-supported region. */
export function egressStub(env: Env): DurableObjectStub {
  const id = env.US_EGRESS.idFromName(
    `oa-egress-${Math.floor(Math.random() * EGRESS_POOL)}`,
  );
  return env.US_EGRESS.get(id, { locationHint: "wnam" });
}

// Headers a browser must be told to expose so the Gemini resumable-upload flow works
// (the client reads x-goog-upload-url, then uploads bytes straight to Google).
const EXPOSE_HEADERS =
  "x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity";

/** Reflect the caller's Origin so browser SDKs can read the response. No-op for
 *  non-browser callers (no Origin). The real key never rides on any CORS path. */
function withCors(res: Response, req: Request): Response {
  const origin = req.headers.get("origin");
  if (origin) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.append("vary", "Origin");
    res.headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  }
  return res;
}

/** Answer the browser preflight. OPTIONS carries no auth header, so it must be handled
 *  before the token checks - otherwise every browser SDK's preflight 401s. */
function corsPreflight(req: Request): Response {
  const res = new Response(null, { status: 204 });
  res.headers.set(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.headers.set(
    "access-control-allow-headers",
    req.headers.get("access-control-request-headers") || "*",
  );
  res.headers.set("access-control-max-age", "86400");
  return withCors(res, req);
}

/** Top-level proxy entry: CORS preflight, then reflect Origin onto every response. */
export async function handleProxy(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflight(req);
  return withCors(await proxyRequest(req, env, ctx), req);
}

/** Validate the proxy token, swap in the real key, forward to the upstream, stream back. */
async function proxyRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const token = extractToken(req, url);
  const provider = routeProvider(req, url);
  if (!token || !provider) return errorResponse(401, "missing token");

  const hash = await sha256hex(token);
  let meta: TokenMetadata | null;
  try {
    meta = await getValidatedByHash(env.TOKENS, hash);
  } catch {
    // KV outage / exhausted read quota: a controlled 503, not an unhandled 1101.
    return errorResponse(503, "token store unavailable");
  }
  if (!meta) return errorResponse(401, "invalid or revoked token");
  if (!meta.providers.includes(coarse(provider)))
    return errorResponse(403, "token not allowed for provider");

  // Per-token rate limit, keyed on the hash (in-process binding, not a subrequest).
  // Fail-open: a missing or erroring limiter must never brick the proxy. The binding
  // counts per-colo, so it is a loose ceiling, not strict abuse prevention.
  let allowed = true;
  try {
    allowed = (await env.RATE_LIMITER.limit({ key: hash })).success;
  } catch {
    allowed = true;
  }
  if (!allowed) {
    const res = errorResponse(429, "rate limit exceeded");
    res.headers.set("retry-after", "60");
    return res;
  }

  const realKey = realKeyFor(provider, env);
  rewriteToUpstream(url, provider, env);
  // Strip the query auth slot for every provider (the URL analogue of swapAuth): a dual-slot
  // client that also sends ?key= must not leak the proxy token into upstream request logs.
  url.searchParams.delete("key");

  const headers = new Headers(req.headers);
  swapAuth(headers, provider, realKey);
  const target = url.toString();
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    if (coarse(provider) === "openai") {
      // Buffer the body so the request can be re-issued through the egress DO. The edge
      // colo this invocation egresses from is fixed, so an in-invocation retry is useless;
      // only re-issuing from a region-pinned DO escapes a geo-blocked colo.
      const body = hasBody ? await req.arrayBuffer() : undefined;
      upstream = await fetch(
        new Request(target, { method: req.method, headers, body }),
      );
      if (await isGeoBlock(upstream)) {
        upstream = await egressStub(env).fetch(
          new Request(target, { method: req.method, headers, body }),
        );
      }
    } else {
      upstream = await fetch(
        new Request(target, { method: req.method, headers, body: req.body }),
      );
    }
  } catch {
    return errorResponse(502, "upstream request failed");
  }

  ctx.waitUntil(touchLastUsed(env.TOKENS, hash));
  return new Response(upstream.body, upstream);
}
