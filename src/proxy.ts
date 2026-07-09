// The proxy hot-path. ZERO framework deps - pure functions + a fetch handler.
// MUST NOT import Hono or any admin code.

import { DurableObject } from "cloudflare:workers";
import { getValidatedByHash, sha256hex, touchLastUsed } from "./tokens";
import { coarse, type Env, type Provider, type TokenMetadata } from "./types";
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

/** Delete every inbound auth slot: the three headers extractToken reads plus the ?key= query
 *  param. Single owner of the slot list - extend here when a new slot is ever added. */
export function stripAuthSlots(headers: Headers, url: URL): void {
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("authorization");
  url.searchParams.delete("key");
}

export function swapAuth(
  headers: Headers,
  url: URL,
  provider: Provider,
  realKey: string,
): void {
  stripAuthSlots(headers, url);
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

const errorResponse = (status: number, error: string) =>
  Response.json({ error }, { status });

/** The validate -> scope -> rate-limit spine shared by the HTTP and WS pipelines. */
export async function authorize(
  env: Env,
  token: string,
  provider: Provider,
): Promise<
  { hash: string; meta: TokenMetadata } | { status: number; message: string }
> {
  const hash = await sha256hex(token);
  let meta: TokenMetadata | "expired" | null;
  try {
    meta = await getValidatedByHash(env.TOKENS, hash);
  } catch (err) {
    // KV outage / exhausted read quota: a controlled 503, not an unhandled 1101.
    console.error("token store read failed", err);
    return { status: 503, message: "token store unavailable" };
  }
  if (meta === "expired") return { status: 401, message: "token expired" };
  if (!meta) return { status: 401, message: "invalid or revoked token" };
  if (!meta.providers.includes(coarse(provider)))
    return { status: 403, message: "token not allowed for provider" };

  // Per-token rate limit, keyed on the hash (in-process binding, not a subrequest).
  // Fail-open: a missing or erroring limiter must never brick the proxy. The binding
  // counts per-colo, so it is a loose ceiling, not strict abuse prevention.
  let allowed = true;
  try {
    allowed = (await env.RATE_LIMITER.limit({ key: hash })).success;
  } catch {
    allowed = true;
  }
  if (!allowed) return { status: 429, message: "rate limit exceeded" };
  return { hash, meta };
}

const EGRESS_POOL = 8;

/** OpenAI 403s requests that egress from an unsupported region (e.g. the Hong Kong colo). */
export async function isGeoBlock(res: Response): Promise<boolean> {
  return (
    res.status === 403 &&
    (await res.clone().text()).includes("unsupported_country_region_territory")
  );
}

// Region-pinned egress relay. OpenAI geo-blocks requests that egress from some Cloudflare
// colos (e.g. Hong Kong) with 403 unsupported_country_region_territory. A Worker's fetch()
// egresses from whatever colo the invocation runs in, and that is fixed per invocation, so an
// in-invocation retry cannot escape a bad colo. Routing the request to this Durable Object via
// locationHint:"wnam" makes the object run in North America; its outbound fetch() then egresses
// from an OpenAI-supported region. The real key never leaves Cloudflare.
export class UsEgress extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
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

export async function handleProxy(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflight(req);
  return withCors(await proxyRequest(req, env, ctx), req);
}

async function proxyRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const token = extractToken(req, url);
  const provider = routeProvider(req, url);
  if (!token || !provider) return errorResponse(401, "missing token");

  const auth = await authorize(env, token, provider);
  if ("status" in auth) {
    const res = errorResponse(auth.status, auth.message);
    if (auth.status === 429) res.headers.set("retry-after", "60");
    return res;
  }

  const realKey = realKeyFor(provider, env);
  rewriteToUpstream(url, provider, env);
  const headers = new Headers(req.headers);
  // swapAuth also mutates url: it strips ?key= so the proxy token never reaches upstream logs.
  swapAuth(headers, url, provider, realKey);
  const target = url.toString();
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    if (coarse(provider) === "openai") {
      // Buffer the body so a geo-403 can be re-issued through the egress DO (UsEgress above).
      const body = hasBody ? await req.arrayBuffer() : undefined;
      const replay = () =>
        new Request(target, { method: req.method, headers, body });
      upstream = await fetch(replay());
      if (await isGeoBlock(upstream)) {
        console.warn("openai geo-403; retrying via the NA egress DO");
        upstream = await egressStub(env).fetch(replay());
      }
    } else {
      upstream = await fetch(
        new Request(target, { method: req.method, headers, body: req.body }),
      );
    }
  } catch (err) {
    console.error("upstream fetch failed", err);
    return errorResponse(502, "upstream request failed");
  }

  ctx.waitUntil(touchLastUsed(env.TOKENS, auth.hash));
  return new Response(upstream.body, upstream);
}
