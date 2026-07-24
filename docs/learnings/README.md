# Learnings

Project-specific decisions and evidence that are worth preserving. Mechanics belong in [`../architecture.md`](../architecture.md); these notes explain why the design exists. Keep relevant dates, sample sizes, and known gaps.

Keep one owner for each fact. Link to it elsewhere instead of copying tables, client lists, or implementation details.

- [openai-egress-geo-block.md](openai-egress-geo-block.md) - evidence behind the US-jurisdiction fallback
- [token-expiry-check-at-validate.md](token-expiry-check-at-validate.md) - why expiry is validated instead of delegated to KV TTL
- [rate-limit-binding-free-and-loose.md](rate-limit-binding-free-and-loose.md) - why the limit is treated as loose abuse control
- [cors-preflight-and-upload-passthrough.md](cors-preflight-and-upload-passthrough.md) - why preflight bypasses auth and Gemini upload URLs pass through
- [compat-is-the-auth-slot-not-the-sdk.md](compat-is-the-auth-slot-not-the-sdk.md) - why distinct clients keep distinct compatibility cases
- [websocket-proxy-auth-slots.md](websocket-proxy-auth-slots.md) - why WebSockets need extra credential handling and a manual bridge
- [kv-free-tier-write-quota.md](kv-free-tier-write-quota.md) - why `lastUsed` is a coarse, throttled stamp
