# Rate Limiting binding: free on Workers Free, but a loose per-colo ceiling

## What we needed

A per-token request-rate cap that costs nothing, needs no new storage, and never lets the real key leave Cloudflare.

## What we found

- The Workers **Rate Limiting binding** (`[[ratelimits]]` in `wrangler.toml` + `env.RATE_LIMITER.limit({ key })`) is an **in-process call, not a subrequest** - no subrequest budget hit, no storage, microseconds of CPU.
- **Free-plan eligibility is undocumented** (a research pass even fabricated a "no additional charge" quote). Verified empirically: `wrangler deploy` on the Free account accepts the binding (the summary lists `env.RATE_LIMITER (N requests/60s) - Rate Limit`) and `limit()` enforces - treat undocumented platform claims as "verify by deploying," not fact.
- It is **per-colo and eventually consistent**. With `limit = 2 / 60s`, ~13 rapid requests slipped through before denials began, and a client spread across two colos can get up to ~2× the limit. Cloudflare describes it as a "loose filter, not suited for strict abuse prevention."
- `period` must be exactly **10 or 60**. The limit is fixed per namespace at deploy time - no per-token-variable limit without tiered namespaces or a Durable Object counter.

## Decisions we keep

- One shared per-token ceiling (KISS), keyed on the token's **SHA-256 hash** (never the plaintext).
- **Fail-open:** wrap `limit()` in try/catch and allow on any error - a missing or flaky limiter must never brick the proxy. The real abuse defense is revoke + scope, not this loose ceiling.
- Return `429` + a static `Retry-After: 60` (the binding returns no reset time; the static value matches `period`).

Related: [proxy-token-security.md](proxy-token-security.md).
