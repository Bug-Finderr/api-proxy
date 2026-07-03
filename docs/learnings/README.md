# Learnings

A running log of project-specific knowledge worth not rediscovering. One topic per file, kept short.

Write a file for anything **non-general**: a gotcha, a constraint, a decision and its why, a platform or
API quirk we hit. The bar is "non-obvious and specific to this project," not "it changed the product
direction." Skip general/common knowledge anyone would already have. Don't rewrite history; append.

Each file: the problem, what we found, and the decision we keep.

- [openai-egress-geo-block.md](openai-egress-geo-block.md) - why OpenAI 403'd ~40% of the time, and the North-America-pinned Durable Object that fixes it
- [provider-routing-by-auth-header.md](provider-routing-by-auth-header.md) - one base URL, no path prefix; route by which auth slot the SDK used
- [proxy-token-security.md](proxy-token-security.md) - how a shareable token rides the SDK's auth slot without ever leaking the real key
- [token-expiry-check-at-validate.md](token-expiry-check-at-validate.md) - why expiry is checked at read time, not via KV TTL, and fail-closed on bad input
- [rate-limit-binding-free-and-loose.md](rate-limit-binding-free-and-loose.md) - the Workers Rate Limiting binding is free on the Free plan but a loose, per-colo ceiling
- [cors-preflight-and-upload-passthrough.md](cors-preflight-and-upload-passthrough.md) - why the browser preflight is answered before auth, and why the Gemini upload URL is passed through untouched
- [compat-is-the-auth-slot-not-the-sdk.md](compat-is-the-auth-slot-not-the-sdk.md) - why one test per auth slot proves every SDK/language/wrapper, so we don't add per-client tests
- [websocket-proxy-auth-slots.md](websocket-proxy-auth-slots.md) - proxying wss (OpenAI Realtime/Responses, Gemini Live), and why a browser smuggles the key in a subprotocol the worker must rewrite
