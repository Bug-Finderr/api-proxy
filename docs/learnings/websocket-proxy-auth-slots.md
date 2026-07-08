# WebSocket proxying, and the wider auth-slot set

## Problem

The proxy only forwarded HTTP. A realtime client hit `wss://api.openai.com/v1/responses` directly with a raw key (a dead one → `invalid_api_key`), bypassing the proxy entirely. We wanted the same token-swap for wss, for any provider with a wss API.

## What we found

- **The endpoint in the bug is real.** `wss://api.openai.com/v1/responses` is OpenAI's *Responses API WebSocket Mode* - distinct from Realtime (`/v1/realtime`), Bearer-header-only. A proxy handling only the Realtime subprotocol would pass the token straight through on `/v1/responses`.
- **A plain Worker is enough - no new Durable Object.** Outbound: `fetch(url, { headers: { Upgrade: "websocket" } })` and read `resp.webSocket`; the scheme stays `http(s):` (a `ws://` URL is *not* how Workers do it - a first research pass reached for Node's `new WebSocket()`, which doesn't exist in Workers, and wrongly concluded a DO was required). Inbound: `WebSocketPair` + a 101 response. Idle sockets don't burn CPU on the Free plan.
- **Manual pipe over transparent pass-through.** Whether CF echoes the negotiated `Sec-WebSocket-Protocol` on a passed-through 101 is undocumented, and a browser handshake fails if the server picks none of the offered subprotocols - so we accept both ends and echo it explicitly. wrangler 4.x is past the old dev-WS echo bugs (workers-sdk #1767, fixed by PR #1930).
- **The WS auth-slot set is wider than HTTP** because a browser `WebSocket` cannot set headers: OpenAI browser clients smuggle the key as an `openai-insecure-api-key.<token>` subprotocol entry, Gemini Live reads `?key=`; server-side clients use Bearer. (Slot-to-swap mapping: architecture §10.) Other providers surveyed - Deepgram, AssemblyAI, ElevenLabs, Azure - add `Authorization: Token`, `?token=`, `xi-api-key`, `Sec-WebSocket-Protocol: token, <key>`: a wss proxy must read credentials from query params and subprotocols, not just headers.

## The decision we keep

Extend strip-all-then-set-one to the query and subprotocol slots too, and reuse the geo-403 DO fallback unchanged. Mechanics and the slot table: architecture §10.

## Caveats

- **The geo-blocked WS-over-DO hop is unproven live** - the trigger is unit-tested with a faked DO, and a real geo-403 can't be forced from here.
- **Live-verified against OpenAI (2026-07-05), not Gemini.** Realtime `session.created` via both the Bearer and subprotocol slots, and a `/v1/responses` WS-mode 101, on the deployed worker. Gemini Live remains mock-only (no key). Automated tests use a mock `ws` upstream by design.

Sources: [CF Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [Using the WebSockets API](https://developers.cloudflare.com/workers/examples/websockets/), [OpenAI Realtime (WebSocket)](https://developers.openai.com/api/docs/guides/realtime-websocket), [OpenAI Responses WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode), [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).
