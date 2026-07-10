// Hot path: MUST NOT import Hono or any admin code.

import { DurableObject } from "cloudflare:workers";
import { getValidatedByHash, sha256hex, touchLastUsed } from "./tokens";
import { coarse, type Env, type Provider, type TokenMetadata } from "./types";
import { rewriteToUpstream } from "./upstreams";

/** Token + provider from whichever auth slot the SDK used (the slot implies the provider). */
export function identify(
  req: Request,
  url: URL,
): { token: string; provider: Provider } | null {
  const h = req.headers;
  const xApiKey = h.get("x-api-key");
  if (xApiKey) return { token: xApiKey, provider: "anthropic" };
  const xGoog = h.get("x-goog-api-key");
  if (xGoog) return { token: xGoog, provider: "gemini" };
  const m = /^Bearer\s+(.+)$/i.exec(h.get("authorization") ?? "");
  if (m) {
    const provider = url.pathname.startsWith("/v1beta/openai/")
      ? "gemini-openai"
      : "openai";
    return { token: m[1].trim(), provider };
  }
  const key = url.searchParams.get("key");
  return key ? { token: key, provider: "gemini" } : null;
}

/** Single owner of the auth-slot list: deletes every slot identify reads. */
export function stripAuthSlots(headers: Headers, url: URL): void {
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("authorization");
  url.searchParams.delete("key");
}

function swapAuth(
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

export async function authorize(
  env: Env,
  token: string,
  provider: Provider,
): Promise<{ hash: string } | { status: number; message: string }> {
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

  // Fail-open: an erroring limiter must never brick the proxy. The binding counts
  // per-colo, so it is a loose ceiling, not strict abuse prevention.
  let allowed = true;
  try {
    allowed = (await env.RATE_LIMITER.limit({ key: hash })).success;
  } catch {
    allowed = true;
  }
  if (!allowed) return { status: 429, message: "rate limit exceeded" };
  return { hash };
}

const EGRESS_POOL = 8;

export async function isGeoBlock(res: Response): Promise<boolean> {
  return (
    res.status === 403 &&
    (await res.clone().text()).includes("unsupported_country_region_territory")
  );
}

// OpenAI geo-403s some colos (e.g. HKG); a Worker's egress colo is fixed per invocation,
// so a retry cannot escape it. The US-jurisdiction DO fetches from a supported region.
// The real key never leaves Cloudflare.
export class UsEgress extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}

export function egressStub(env: Env): DurableObjectStub {
  return env.US_EGRESS.jurisdiction("us").getByName(
    `oa-egress-${Math.floor(Math.random() * EGRESS_POOL)}`,
  );
}

// The browser Gemini resumable-upload flow breaks unless these response headers are exposed.
const EXPOSE_HEADERS =
  "x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity";

/** Reflective CORS is intentional; the real key never rides on any CORS path. */
function withCors(res: Response, req: Request): Response {
  const origin = req.headers.get("origin");
  if (origin) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.append("vary", "Origin");
    res.headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  }
  return res;
}

/** OPTIONS carries no auth header, so preflight must be answered before token checks. */
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
  const id = identify(req, url);
  if (!id) return errorResponse(401, "missing token");
  const { provider } = id;

  const auth = await authorize(env, id.token, provider);
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
        console.warn("openai geo-403; retrying via the US egress DO");
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
