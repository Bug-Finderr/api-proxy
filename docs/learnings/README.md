# Learnings

A running log of project-specific knowledge worth not rediscovering. One topic per file, kept short.

Write a file for anything **non-obvious and specific to this project** - a gotcha, constraint, decision, or platform quirk. Correct stale claims in place while preserving dates, sample sizes, and known gaps.

Each file: the problem, what we found, and the decision we keep. Design/mechanics live in [`../architecture.md`](../architecture.md); these files hold only the why.

- [openai-egress-geo-block.md](openai-egress-geo-block.md) - the historical geo-403 evidence, its missing denominator, and the measured US-jurisdiction fallback
- [provider-routing-by-auth-header.md](provider-routing-by-auth-header.md) - one base URL, no path prefix; route by which auth slot the SDK used
- [proxy-token-security.md](proxy-token-security.md) - auth-slot stripping and hashed proxy-token storage
- [token-expiry-check-at-validate.md](token-expiry-check-at-validate.md) - why expiry is checked at read time, not via KV TTL, and fail-closed on bad input
- [rate-limit-binding-free-and-loose.md](rate-limit-binding-free-and-loose.md) - the Workers Rate Limiting binding is free on the Free plan but a loose, per-location ceiling
- [cors-preflight-and-upload-passthrough.md](cors-preflight-and-upload-passthrough.md) - why the browser preflight is answered before auth, and why the Gemini upload URL is passed through untouched
- [compat-is-the-auth-slot-not-the-sdk.md](compat-is-the-auth-slot-not-the-sdk.md) - why routing is slot-based but every maintained client still needs its own compatibility case
- [websocket-proxy-auth-slots.md](websocket-proxy-auth-slots.md) - WebSocket auth slots, close coordination, and the fetch-with-upgrade choice
- [kv-free-tier-write-quota.md](kv-free-tier-write-quota.md) - 1,000 KV writes/day (account-wide, 100x scarcer than reads); why `lastUsed` stamps at most once per day
