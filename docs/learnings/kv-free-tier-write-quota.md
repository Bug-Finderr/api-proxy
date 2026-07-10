# Free-tier KV: writes are the budget, and the quota is account-wide

## Problem

Every proxied request and WebSocket upgrade stamped `lastUsed` with one KV write. One day (~500 requests) triggered Cloudflare's "50% of your daily Workers KV limit" warning email, spending half the write quota on dashboard recency.

## What we found

- Free-tier KV allows **1,000 writes/day** but **100,000 reads/day** (also 1k deletes, 1k lists, 1 GB; reset 00:00 UTC). Writes are the scarce resource, 100x scarcer than reads.
- **Daily quotas are per account, not per namespace.** Every worker and namespace on the account draws from one pool, and dashboard/wrangler KV operations count against it too. A dedicated namespace isolates data, not quota.
- **Exceeding a limit fails only that operation type.** Exhausted writes leave reads (token auth) working, and since the stamp runs in `ctx.waitUntil` after the response has streamed back, write exhaustion is invisible to clients - a stale column plus log noise, not an outage. The "429" in Cloudflare's warning email refers to the rejected `put()` calls themselves.
- `cacheTtl` on `get()` is a latency optimization only; cache-served reads still count as billed reads. To cut counted reads you must not call KV at all.
- The 50%/90% warning emails are real but **undocumented** (no threshold or schedule anywhere in the notifications catalog) - don't build on them.

## The decision we keep

`touchLastUsed` stamps **at most once per UTC day per token per isolate**. The first qualifying use observed by that isolate wins: an authorized HTTP request that receives any upstream response, or a successful WebSocket upgrade. The UI localizes the stored ISO timestamp, but it is a coarse first-observed marker rather than the literal latest use.

A module-scope map claims the day before the first `await`, so concurrent requests in one isolate deduplicate. The map is never pruned and can grow by one entry per used token for that isolate's lifetime. Isolate churn can produce multiple writes per token/day; no duplication factor was measured.

A failed put releases the claim so a later request retries inside `waitUntil`; reads stay unmemoized so revocation is not delayed further.

Related: [proxy-token-security.md](proxy-token-security.md) (why `lastUsed` lives in its own `:lu` side key), [rate-limit-binding-free-and-loose.md](rate-limit-binding-free-and-loose.md).

Sources: [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
