# WebSocket proxying, and the wider auth-slot set

## Problem

The proxy only forwarded HTTP. A realtime client hit `wss://api.openai.com/v1/responses` directly with a raw key (a dead one → `invalid_api_key`), bypassing the proxy entirely. We wanted the same token-swap for wss, for any provider with a wss API.

## What we found

- **The endpoint in the bug is real.** `wss://api.openai.com/v1/responses` is OpenAI's *Responses API WebSocket Mode* - distinct from Realtime (`/v1/realtime`), Bearer-header-only. A proxy handling only the Realtime subprotocol would pass the token straight through on `/v1/responses`.
- **A plain Worker is enough.** Workers now support outbound `new WebSocket()`, but constructor-created sockets cannot opt into half-open behavior. This proxy retains `fetch(httpUrl, { headers: { Upgrade: "websocket" } })` so the returned socket can use `accept({ allowHalfOpen: true })` and coordinate closes with the `WebSocketPair` endpoint.
- **Manual pipe over transparent pass-through.** Whether CF echoes the negotiated `Sec-WebSocket-Protocol` on a passed-through 101 is undocumented, and a browser handshake fails if the server picks none of the offered subprotocols - so we accept both ends and echo it explicitly. wrangler 4.x is past the old dev-WS echo bugs (workers-sdk #1767, fixed by PR #1930).
- **The WS auth-slot set is wider than HTTP.** OpenAI browser clients place the key in an `openai-insecure-api-key.<token>` subprotocol entry because browser WebSockets cannot set arbitrary headers. Server OpenAI clients use Bearer, Gemini Live uses `?key=`, and an `x-api-key` upgrade routes to Anthropic. Slot mapping: architecture §10.

## The decision we keep

Extend strip-all-then-set-one to the query and subprotocol slots too, and reuse the geo-403 DO fallback unchanged. Mechanics and the slot table: architecture §10.

## Caveats

- **The geo-blocked WS-over-DO hop is unproven live** - the trigger is unit-tested with a faked DO, and a real geo-403 can't be forced from here.
- **Live-verified against OpenAI (2026-07-05), not Gemini.** Realtime `session.created` via both the Bearer and subprotocol slots, and a `/v1/responses` WS-mode 101, on the deployed worker. Gemini Live remains mock-only (no key). Automated tests use a mock `ws` upstream by design.

Sources: [CF Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [Workers compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/), [OpenAI Realtime (WebSocket)](https://developers.openai.com/api/docs/guides/realtime-websocket), [OpenAI Responses WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode), [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).
