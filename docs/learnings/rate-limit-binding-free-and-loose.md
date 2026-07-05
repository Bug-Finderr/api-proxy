# Rate Limiting binding: free on Workers Free, but a loose per-colo ceiling

## Problem

A per-token request-rate cap that costs nothing, needs no new storage, and never lets the real key leave Cloudflare.

## What we found

- **Free-plan eligibility is undocumented** (a research pass even fabricated a "no additional charge" quote). Verified empirically: `wrangler deploy` on the Free account accepts the binding (the summary lists `env.RATE_LIMITER (N requests/60s) - Rate Limit`) and `limit()` enforces - treat undocumented platform claims as "verify by deploying," not fact.
- **It is per-colo and eventually consistent.** With `limit = 2 / 60s`, ~13 rapid requests slipped through before denials began, and a client spread across two colos can get ~2x the limit. Cloudflare's own words: a "loose filter, not suited for strict abuse prevention."
- The limit is **fixed per namespace at deploy time** - no per-token-variable limit without tiered namespaces or a Durable Object counter.

## The decision we keep

Key on the hash, never the plaintext. Fail-open, because the real abuse defense is revoke + scope, not this loose ceiling. `Retry-After` is a static 60 because the binding returns no reset time. Config and semantics: architecture §7.

Related: [proxy-token-security.md](proxy-token-security.md).
