# Learnings

A running log of project-specific knowledge worth not rediscovering. One topic per file, kept short.

Write a file for anything **non-obvious and specific to this project** - a gotcha, a constraint, a decision and its why, a platform quirk; skip what anyone would already know. Don't rewrite history; append.

Each file: the problem, what we found, and the decision we keep. Design/mechanics live in [`../architecture.md`](../architecture.md); these files hold only the why.

- [openai-egress-geo-block.md](openai-egress-geo-block.md) - why OpenAI 403'd ~40% of the time, and the North-America-pinned Durable Object that fixes it
- [provider-routing-by-auth-header.md](provider-routing-by-auth-header.md) - one base URL, no path prefix; route by which auth slot the SDK used
- [proxy-token-security.md](proxy-token-security.md) - how a shareable token rides the SDK's auth slot without ever leaking the real key
- [token-expiry-check-at-validate.md](token-expiry-check-at-validate.md) - why expiry is checked at read time, not via KV TTL, and fail-closed on bad input
- [rate-limit-binding-free-and-loose.md](rate-limit-binding-free-and-loose.md) - the Workers Rate Limiting binding is free on the Free plan but a loose, per-colo ceiling
- [cors-preflight-and-upload-passthrough.md](cors-preflight-and-upload-passthrough.md) - why the browser preflight is answered before auth, and why the Gemini upload URL is passed through untouched
- [compat-is-the-auth-slot-not-the-sdk.md](compat-is-the-auth-slot-not-the-sdk.md) - the auth slot fixes compatibility, so each distinct library gets one test in one language; per-language packages and end-user apps are documented, not re-tested
- [websocket-proxy-auth-slots.md](websocket-proxy-auth-slots.md) - proxying wss (OpenAI Realtime/Responses, Gemini Live), and why a browser smuggles the key in a subprotocol the worker must rewrite
- [kv-free-tier-write-quota.md](kv-free-tier-write-quota.md) - 1,000 KV writes/day (account-wide, 100x scarcer than reads); why `lastUsed` stamps at most once per day
