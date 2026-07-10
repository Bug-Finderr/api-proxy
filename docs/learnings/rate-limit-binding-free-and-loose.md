# Rate Limiting binding: free on Workers Free, but a loose per-location ceiling

## Problem

A per-token request-rate cap with no new storage that never uses plaintext tokens as limiter keys.

## What we found

- **Free-plan eligibility is undocumented** (a research pass even fabricated a "no additional charge" quote). Verified empirically: `wrangler deploy` on the Free account accepts the binding (the summary lists `env.RATE_LIMITER (N requests/60s) - Rate Limit`) and `limit()` enforces - treat undocumented platform claims as "verify by deploying," not fact.
- **It is per-location and eventually consistent.** With `limit = 2 / 60s`, ~13 rapid requests slipped through before denials began in the local test. Because Cloudflare documents independent counters by location, roughly 2x across two locations is an inference, not a measurement from that run.
- The limit is **fixed per namespace at deploy time** - no per-token-variable limit without tiered namespaces or a Durable Object counter.

## The decision we keep

Key on the hash, never the plaintext. Fail-open, because the real abuse defense is revoke + scope, not this loose ceiling. `Retry-After` is a static 60 because the binding returns no reset time. Config and semantics: architecture §7.

Related: [proxy-token-security.md](proxy-token-security.md). Primary source: [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
