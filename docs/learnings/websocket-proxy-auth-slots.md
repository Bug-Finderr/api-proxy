# WebSocket proxying, and the wider auth-slot set

## Problem

The proxy only forwarded HTTP. A user's realtime client hit `wss://api.openai.com/v1/responses` directly with a raw key (a dead one → `invalid_api_key`), bypassing the proxy entirely because the proxy couldn't carry a WebSocket. We wanted the same token-swap for wss, for any provider that has a wss API, not just OpenAI.

## What we found

**The endpoint in the bug is real.** `wss://api.openai.com/v1/responses` is OpenAI's *Responses API WebSocket Mode* — distinct from the Realtime API (`/v1/realtime`). It authenticates **only** via the `Authorization: Bearer` header. So a proxy that handled only the Realtime subprotocol would pass the token straight through on `/v1/responses`. Both endpoints share `api.openai.com`, routed on path.

**A plain Worker is enough — no new Durable Object.** Cloudflare Workers open an upstream socket with `fetch(url, { headers: { Upgrade: "websocket" } })` and read `resp.webSocket`; the scheme stays `http(s):`, the header drives the upgrade (a `ws://`/`wss://` URL is *not* how you do it in a Worker). Inbound, `new WebSocketPair()` + `return new Response(null, { status: 101, webSocket: client })`. Works on the Free plan; idle sockets don't burn CPU time. (A first research pass wrongly concluded a DO was required — it had reached for the Node `new WebSocket()` constructor, which doesn't exist in Workers.)

**Manual pipe over transparent pass-through.** You *can* return the upstream's 101 response directly and let CF pipe both ends, but whether it faithfully echoes the negotiated `Sec-WebSocket-Protocol` back to the client is undocumented (and a browser handshake fails if the server doesn't pick one of the client's offered subprotocols). So we accept both ends in JS (`WebSocketPair` + frame pump) and set the echoed subprotocol explicitly. wrangler ≥ those old dev-WS echo bugs (workers-sdk #1767, fixed by PR #1930) — we're on 4.x, fine.

**The WS auth-slot set is wider than HTTP**, because a browser `WebSocket` cannot set request headers:

| Inbound slot | Provider | Why |
|---|---|---|
| `Authorization: Bearer <token>` | openai | server-side Realtime + all Responses-mode |
| `Sec-WebSocket-Protocol: realtime, openai-insecure-api-key.<token>` | openai | browser Realtime — the only slot a browser can use |
| `?key=<token>` query | gemini | Gemini Live (`…BidiGenerateContent`) reads the key in the query |

Anthropic has no wss API (Messages is SSE-over-HTTP only) — naturally excluded. (Other providers surveyed — Deepgram, AssemblyAI, ElevenLabs, Azure — add yet more slots: `Authorization: Token`, `?token=`, `xi-api-key`, `Sec-WebSocket-Protocol: token, <key>`. We don't proxy those, but the pattern holds: a wss proxy must read credentials from query params and subprotocols, not just headers.)

## The decision we keep

`src/ws.ts` mirrors the HTTP path (validate hash → scope → rate-limit) then `prepareWsUpstream` strips every inbound auth slot and sets exactly one upstream — the WS analogue of `swapAuth`:

- OpenAI: real key as `Authorization: Bearer` (even when the client smuggled it in the subprotocol — the worker *can* set headers; we drop the `openai-insecure-api-key.*` entry and keep `realtime` + org/project/beta so negotiation still picks `realtime`).
- Gemini: real key in `?key=` (not a header — that's where Live reads it).

The proxy token therefore never reaches the upstream in any slot (header, query, or subprotocol); a test asserts it. The OpenAI geo-403 fallback is reused as-is: a 403 from a bad colo re-issues the upgrade through the `UsEgress` DO, which carries a WebSocket exactly like a plain `fetch`.

## Caveats

- **Rate limit and token validation are per-connection, not per-frame.** One upgrade = one limiter hit; a revoke takes effect on the next connection, not on an open stream. For an immediate cutoff, rotate the provider secret.
- **Idle timeout.** Cloudflare closes a socket after a quiet period in both directions; a silent client should keep-alive (realtime audio/text traffic keeps it warm on its own).
- **The geo-blocked WS-over-DO hop is not locally testable.** The trigger logic is unit-tested with a faked DO; the live DO-carries-a-WebSocket hop reuses HTTP's (proven-in-prod) egress path but isn't separately exercised. Treat it as built-but-unproven for wss until a geo-blocked colo hits it live.
- **Live realtime is untested end-to-end.** Tests prove the upgrade, swap, and bidirectional frames against a mock `ws` upstream; no test connects to a real OpenAI/Gemini realtime endpoint.

Sources: [CF Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [Using the WebSockets API](https://developers.cloudflare.com/workers/examples/websockets/), [OpenAI Realtime (WebSocket)](https://developers.openai.com/api/docs/guides/realtime-websocket), [OpenAI Responses WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode), [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).
