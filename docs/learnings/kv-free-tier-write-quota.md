# Free-tier KV: writes are the budget, and the quota is account-wide

## What happened

Every proxied request (and every WS upgrade) stamped `lastUsed` with one KV write. One day (~500 requests) tripped Cloudflare's "50% of your daily Workers KV limit" warning email - half the day's write quota spent on a column that only shows a date.

## What we found

- Free-tier KV allows **1,000 writes/day** but **100,000 reads/day** (also 1k deletes, 1k lists, 1 GB; reset 00:00 UTC). Writes are the scarce resource, 100x scarcer than reads.
- **Daily quotas are per account, not per namespace.** Every worker and namespace on the account draws from one pool, and dashboard/wrangler KV operations count against it too. A dedicated namespace isolates data, not quota.
- **Exceeding a limit fails only that operation type.** Exhausted writes leave reads (token auth) working, and since the stamp runs in `ctx.waitUntil` after the response has streamed back, write exhaustion is invisible to clients - a stale column plus log noise, not an outage. The "429" in Cloudflare's warning email refers to the rejected `put()` calls themselves.
- `cacheTtl` on `get()` is a latency optimization only; cache-served reads still count as billed reads. To cut counted reads you must not call KV at all.
- The 50%/90% warning emails are real but **undocumented** (no threshold or schedule anywhere in the notifications catalog) - don't build on them.

## The decision we keep

`touchLastUsed` stamps **at most once per UTC day per token**: a module-scope day-memo checked synchronously before the first `await` (atomic on the single-threaded isolate), keyed only by validated hashes so it can't grow unbounded. It lives in `tokens.ts` so both call sites are covered - the HTTP hot path and the per-connection WS path, where a flapping realtime client reconnecting every second would otherwise burn ~86k writes/day on its own. The dashboard shows only the date, so nothing visible is lost.

Accepted trades: a failed put releases the day-claim so the next request retries (on a quota-exhausted day that is one doomed, quota-free retry per request inside `waitUntil` - invisible to clients), and isolate churn re-stamps at worst a handful of times per token per day. Reads stay unmemoized - 100x headroom, and a memo would delay revocation for no binding win.

Related: [proxy-token-security.md](proxy-token-security.md) (why `lastUsed` lives in its own `:lu` side key), [rate-limit-binding-free-and-loose.md](rate-limit-binding-free-and-loose.md).

Sources: [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
