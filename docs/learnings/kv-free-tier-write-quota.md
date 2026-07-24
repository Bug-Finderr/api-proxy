# Free-tier KV writes are the budget

## Problem

Writing `lastUsed` on every authorized request spent half the daily KV write allowance after roughly 500 requests.

## Evidence

The Free tier allows 1,000 writes but 100,000 reads per day. These quotas are account-wide, not isolated by namespace. Exhausting writes does not stop reads, so token authorization can continue while usage stamps fail.

`lastUsed` writes are scheduled with `ctx.waitUntil`; a failed stamp cannot change the response already chosen for the client. It only leaves stale dashboard data and a log entry.

## Decision

Stamp at most once per UTC day, per token, per isolate. The value is a coarse first-observed marker, not an exact latest-use timestamp. Keep it in a separate `<hash>:lu` key so an activity write cannot overwrite token status or expiry.

Isolate churn can still produce more than one write per token per day. A failed write releases the in-memory claim so a later request can retry.

Sources: [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
