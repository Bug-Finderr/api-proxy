# WebSocket proxying needs extra credential handling

## Problem

Realtime clients could bypass the proxy or send a proxy token upstream because browser WebSockets cannot set arbitrary authorization headers.

## Evidence

OpenAI server clients use Bearer, browser clients place the key in an `openai-insecure-api-key.<token>` subprotocol entry, Gemini Live uses `?key=`, and Anthropic-style upgrades use `x-api-key`.

Constructor-created Worker sockets cannot opt into the half-open behavior used to coordinate close frames. A fetched upgrade can, and a manual bridge can echo the negotiated subprotocol explicitly.

## Decision

Use `fetch()` with an upgrade request, bridge the two sockets, and extend strip-all-then-set-one to query and subprotocol credentials. Reuse the OpenAI geo-403 fallback for upgrades.

The geo-blocked Durable Object upgrade is covered with a fake object but has not been forced live. On 2026-07-05, OpenAI Realtime and Responses upgrades were verified against the deployed Worker; Gemini Live remains mock-only.

Sources: [CF Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime-websocket), [OpenAI Responses WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode), [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket).
