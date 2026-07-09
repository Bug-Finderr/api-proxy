// The WebSocket proxy hot-path. Mirrors proxy.ts (validate the token -> swap in the real key ->
// forward), but for a WS upgrade handshake plus a bidirectional frame pump.

import {
  authorize,
  egressStub,
  extractToken,
  isGeoBlock,
  realKeyFor,
  routeProvider,
  stripAuthSlots,
} from "./proxy";
import { touchLastUsed } from "./tokens";
import { coarse, type Env, type Provider } from "./types";
import { rewriteToUpstream } from "./upstreams";

// A browser WebSocket cannot set headers, so OpenAI clients smuggle the key as a
// Sec-WebSocket-Protocol entry; we re-present it as a Bearer header upstream and keep
// the remaining subprotocols so the handshake still negotiates "realtime".
const OPENAI_KEY_SUBPROTOCOL = "openai-insecure-api-key.";

// Close codes a peer is not allowed to send back via close(); forward as a bare close() instead.
const CLOSE_FORBIDDEN = new Set([1004, 1005, 1006, 1015]);

const subprotocols = (header: string | null): string[] =>
  header
    ? header
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

function subprotocolToken(header: string | null): string | null {
  for (const v of subprotocols(header))
    if (v.startsWith(OPENAI_KEY_SUBPROTOCOL))
      return v.slice(OPENAI_KEY_SUBPROTOCOL.length) || null;
  return null;
}

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
  // The scheme stays http(s): a Worker opens an upstream socket by fetching the http(s)
  // URL with `Upgrade: websocket`, not a ws:// URL.
  rewriteToUpstream(url, provider, env);

  const headers = new Headers(req.headers);
  stripAuthSlots(headers, url);
  // The handshake headers are runtime-owned; drop the client's and signal upgrade intent.
  headers.delete("sec-websocket-key");
  headers.delete("sec-websocket-version");
  headers.delete("sec-websocket-accept");
  headers.set("upgrade", "websocket");

  if (provider === "gemini") {
    url.searchParams.set("key", realKey); // Gemini Live takes the key in the query
  } else if (provider === "anthropic") {
    headers.set("x-api-key", realKey);
  } else {
    headers.set("authorization", `Bearer ${realKey}`); // openai + gemini-openai
  }

  const kept = subprotocols(headers.get("sec-websocket-protocol")).filter(
    (s) => !s.startsWith(OPENAI_KEY_SUBPROTOCOL),
  );
  if (kept.length) headers.set("sec-websocket-protocol", kept.join(", "));
  else headers.delete("sec-websocket-protocol");

  return { target: url.toString(), headers };
}

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

  // The limiter gates the connection, not each frame: one upgrade = one limiter hit.
  const auth = await authorize(env, token, provider);
  if ("status" in auth)
    return new Response(auth.message, {
      status: auth.status,
      headers: auth.status === 429 ? { "retry-after": "60" } : undefined,
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
    // Same geo-403 escape hatch as HTTP (see UsEgress in proxy.ts).
    if (coarse(provider) === "openai" && (await isGeoBlock(upstreamRes))) {
      console.warn(
        "openai geo-403 on ws upgrade; retrying via the NA egress DO",
      );
      upstreamRes = await egressStub(env).fetch(
        new Request(target, { headers }),
      );
    }
  } catch (err) {
    console.error("ws upstream connect failed", err);
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

  ctx.waitUntil(touchLastUsed(env.TOKENS, auth.hash));

  const res = new Response(null, { status: 101, webSocket: client });
  // Echo the subprotocol the upstream actually chose (e.g. "realtime"); a browser handshake
  // fails if the server doesn't pick one of the client's offered subprotocols.
  const negotiated = upstreamRes.headers.get("sec-websocket-protocol");
  if (negotiated) res.headers.set("sec-websocket-protocol", negotiated);
  return res;
}
