import { authorize, identify, stripAuthSlots } from "./auth";
import { touchLastUsed } from "./tokens";
import { coarse, type Env, type Provider } from "./types";
import {
  egressStub,
  isGeoBlock,
  realKeyFor,
  rewriteToUpstream,
} from "./upstreams";

// Browsers cannot set WebSocket headers, so OpenAI carries the key in Sec-WebSocket-Protocol.
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

function identifyWs(req: Request, url: URL) {
  const id = identify(req, url);
  if (id) return id;
  const token = subprotocolToken(req.headers.get("sec-websocket-protocol"));
  return token ? { token, provider: "openai" as const } : null;
}

function prepareWsUpstream(
  req: Request,
  url: URL,
  provider: Provider,
  realKey: string,
  env: Env,
): { target: string; headers: Headers } {
  // Workers open upstream sockets by fetching the http(s) URL with Upgrade, never ws://.
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
    headers.set("authorization", `Bearer ${realKey}`);
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

export async function handleWsProxy(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const id = identifyWs(req, url);
  if (!id) return new Response("missing token", { status: 401 });

  const auth = await authorize(env, id.token, id.provider);
  if ("status" in auth)
    return new Response(auth.message, {
      status: auth.status,
      headers: auth.status === 429 ? { "retry-after": "60" } : undefined,
    });

  const { target, headers } = prepareWsUpstream(
    req,
    url,
    id.provider,
    realKeyFor(id.provider, env),
    env,
  );

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(target, { headers });
    if (coarse(id.provider) === "openai" && (await isGeoBlock(upstreamRes))) {
      console.warn(
        "openai geo-403 on ws upgrade; retrying via the US egress DO",
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
  if (!upstream) return upstreamRes;

  const [client, server] = Object.values(new WebSocketPair());
  // Force ArrayBuffer: this compatibility_date delivers Blob frames by default, which send() rejects (silent drop).
  upstream.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstream.accept({ allowHalfOpen: true });
  server.accept({ allowHalfOpen: true });
  pump(server, upstream);
  pump(upstream, server);

  ctx.waitUntil(touchLastUsed(env.TOKENS, auth.hash));

  const res = new Response(null, { status: 101, webSocket: client });
  // A browser handshake fails unless the server picks one of the client's offered subprotocols.
  const negotiated = upstreamRes.headers.get("sec-websocket-protocol");
  if (negotiated) res.headers.set("sec-websocket-protocol", negotiated);
  return res;
}
