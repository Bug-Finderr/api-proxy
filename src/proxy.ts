// Hot path: MUST NOT import Hono or any admin code.

import { authorize, identify } from "./auth";
import { touchLastUsed } from "./tokens";
import { coarse, type Env } from "./types";
import {
  egressStub,
  isGeoBlock,
  realKeyFor,
  rewriteToUpstream,
  swapAuth,
} from "./upstreams";

const errorResponse = (status: number, error: string) =>
  Response.json({ error }, { status });

// The browser Gemini resumable-upload flow breaks unless these response headers are exposed.
const EXPOSE_HEADERS =
  "x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity";

/** Reflective CORS supports browser SDKs; provider credentials stay upstream-only. */
function withCors(res: Response, req: Request): Response {
  const origin = req.headers.get("origin");
  if (origin) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.append("vary", "Origin");
    res.headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  }
  return res;
}

/** Preflight omits credential headers; answer before auth or upstream work. */
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
  // swapAuth strips ?key= before the proxy token can reach upstream logs.
  swapAuth(headers, url, provider, realKey);
  const target = url.toString();
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    if (coarse(provider) === "openai") {
      // Buffer the body so a geo-403 can be re-issued through the egress DO.
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
