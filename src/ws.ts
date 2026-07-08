// The WebSocket proxy hot-path. Mirrors proxy.ts (validate the token -> swap in the real key ->
// forward), but for a WS upgrade handshake plus a bidirectional frame pump. Anthropic has no wss
// API today; OpenAI (`/v1/realtime`, `/v1/responses`) and Gemini Live (`...BidiGenerateContent`)
// do. Auth on a WS handshake can sit in a header, a `?key=` query param, or - because a browser
// WebSocket cannot set headers - the `Sec-WebSocket-Protocol` subprotocol.

import {
  coarse,
  egressStub,
  extractToken,
  isGeoBlock,
  realKeyFor,
  routeProvider,
} from "./proxy";
import { getValidatedByHash, sha256hex, touchLastUsed } from "./tokens";
import type { Env, Provider, TokenMetadata } from "./types";
import { rewriteToUpstream } from "./upstreams";

// OpenAI browser clients smuggle the key as a Sec-WebSocket-Protocol entry, since a browser
// WebSocket cannot set the Authorization header. Offered shape: ["realtime",
// "openai-insecure-api-key.<KEY>", "openai-organization.<ID>"?, "openai-project.<ID>"?,
// "openai-beta.realtime-v1"?]. We read the key here and re-present it as a Bearer header upstream
// (the worker CAN set headers), keeping the remaining subprotocols so the handshake still
// negotiates "realtime".
const OPENAI_KEY_SUBPROTOCOL = "openai-insecure-api-key.";

// Close codes a peer is not allowed to send back via close(); forward as a bare close() instead.
const CLOSE_FORBIDDEN = new Set([1004, 1005, 1006, 1015]);

/** The proxy token from the subprotocol list, if a browser smuggled it there. */
function subprotocolToken(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const v = part.trim();
    if (v.startsWith(OPENAI_KEY_SUBPROTOCOL))
      return v.slice(OPENAI_KEY_SUBPROTOCOL.length) || null;
  }
  return null;
}

/** Proxy token from any WS auth slot: the HTTP slots (header/query) plus the subprotocol. */
export function extractWsToken(req: Request, url: URL): string | null {
  return (
    extractToken(req, url) ??
    subprotocolToken(req.headers.get("sec-websocket-protocol"))
  );
}

/** Provider from any WS auth slot. A subprotocol-smuggled key is always OpenAI. */
export function routeWsProvider(req: Request, url: URL): Provider | null {
  return (
    routeProvider(req, url) ??
    (subprotocolToken(req.headers.get("sec-websocket-protocol"))
      ? "openai"
      : null)
  );
}

/** Rewrite the URL to the upstream and build the upgrade headers with the real key in the slot
 *  that provider's WS API expects. The proxy token leaves no slot. Pure + exported for tests. */
export function prepareWsUpstream(
  req: Request,
  url: URL,
  provider: Provider,
  realKey: string,
  env: Env,
): { target: string; headers: Headers } {
  // Rewrite host/port (path + query kept). The scheme stays http(s): a Worker opens an upstream
  // socket by fetching the http(s) URL with `Upgrade: websocket`, not by using a ws:// URL.
  rewriteToUpstream(url, provider, env);

  const headers = new Headers(req.headers);
  // Strip every inbound auth slot, then set exactly one upstream (the WS analogue of swapAuth).
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("authorization");
  // The handshake headers are runtime-owned; drop the client's so CF regenerates them for the
  // upstream leg, and signal upgrade intent explicitly.
  headers.delete("sec-websocket-key");
  headers.delete("sec-websocket-version");
  headers.delete("sec-websocket-accept");
  headers.set("upgrade", "websocket");

  if (provider === "gemini") {
    url.searchParams.set("key", realKey); // Gemini Live takes the key in the query
  } else {
    url.searchParams.delete("key");
    if (provider === "anthropic") headers.set("x-api-key", realKey);
    else headers.set("authorization", `Bearer ${realKey}`); // openai + gemini-openai
  }

  // Drop the smuggled key entry from the subprotocol offer, keep the rest (realtime, org,
  // project, beta). Remove the header entirely if nothing else remains.
  const proto = headers.get("sec-websocket-protocol");
  if (proto) {
    const kept = proto
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith(OPENAI_KEY_SUBPROTOCOL));
    if (kept.length) headers.set("sec-websocket-protocol", kept.join(", "));
    else headers.delete("sec-websocket-protocol");
  }

  return { target: url.toString(), headers };
}

/** The close code to forward to the peer, or null to send a bare close(): a peer may not send the
 *  reserved/abnormal codes in CLOSE_FORBIDDEN or anything outside 1000-4999. */
export function forwardCloseCode(code: number): number | null {
  return code >= 1000 && code <= 4999 && !CLOSE_FORBIDDEN.has(code)
    ? code
    : null;
}

/** Forward frames + a sanitized close/error from one socket to the other. */
function pump(from: WebSocket, to: WebSocket): void {
  from.addEventListener("message", (e: MessageEvent) => {
    try {
      to.send(e.data as string | ArrayBuffer);
    } catch {}
  });
  from.addEventListener("close", (e: CloseEvent) => {
    try {
      const code = forwardCloseCode(e.code);
      if (code !== null) to.close(code, e.reason);
      else to.close();
    } catch {}
  });
  from.addEventListener("error", () => {
    try {
      to.close(1011, "upstream error");
    } catch {}
  });
}

/** Validate the token, swap in the real key, open the upstream socket, pipe both ends. */
export async function handleWsProxy(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const token = extractWsToken(req, url);
  const provider = routeWsProvider(req, url);
  if (!token || !provider)
    return new Response("missing token", { status: 401 });

  const hash = await sha256hex(token);
  let meta: TokenMetadata | null;
  try {
    meta = await getValidatedByHash(env.TOKENS, hash);
  } catch {
    // KV outage / exhausted read quota: a controlled 503, not an unhandled 1101.
    return new Response("token store unavailable", { status: 503 });
  }
  if (!meta) return new Response("invalid or revoked token", { status: 401 });
  if (!meta.providers.includes(coarse(provider)))
    return new Response("token not allowed for provider", { status: 403 });

  // Per-token rate limit, same fail-open binding as the HTTP path. Gates the connection, not each
  // frame: one upgrade = one limiter hit.
  let allowed = true;
  try {
    allowed = (await env.RATE_LIMITER.limit({ key: hash })).success;
  } catch {
    allowed = true;
  }
  if (!allowed)
    return new Response("rate limit exceeded", {
      status: 429,
      headers: { "retry-after": "60" },
    });

  const realKey = realKeyFor(provider, env);
  const { target, headers } = prepareWsUpstream(
    req,
    url,
    provider,
    realKey,
    env,
  );

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(target, { headers });
    // Same OpenAI geo-403 escape hatch as HTTP: a 403 from a bad colo is retried from the
    // NA-pinned egress DO, which carries the WS upgrade just like a plain fetch.
    if (coarse(provider) === "openai" && (await isGeoBlock(upstreamRes)))
      upstreamRes = await egressStub(env).fetch(
        new Request(target, { headers }),
      );
  } catch {
    return new Response("upstream connect failed", { status: 502 });
  }

  const upstream = upstreamRes.webSocket;
  if (!upstream)
    // Upstream refused the upgrade (401/403/426/...). Surface its handshake response so the
    // client sees the real error rather than a generic 502.
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: upstreamRes.headers,
    });

  const [client, server] = Object.values(new WebSocketPair());
  // Keep binary frames as ArrayBuffer regardless of compatibility_date: newer dates deliver them as
  // Blob, which workerd's send() rejects - a forwarded realtime audio frame would silently drop.
  upstream.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstream.accept();
  server.accept();
  pump(server, upstream);
  pump(upstream, server);

  ctx.waitUntil(touchLastUsed(env.TOKENS, hash));

  const res = new Response(null, { status: 101, webSocket: client });
  // Echo the subprotocol the upstream actually chose (e.g. "realtime"); a browser handshake
  // fails if the server doesn't pick one of the client's offered subprotocols.
  const negotiated = upstreamRes.headers.get("sec-websocket-protocol");
  if (negotiated) res.headers.set("sec-websocket-protocol", negotiated);
  return res;
}
