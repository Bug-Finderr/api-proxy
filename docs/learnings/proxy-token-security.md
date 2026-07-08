# Proxy token security

## Problem

Share provider access without exposing the real key, revocably, with unmodified SDKs - and no leak in any direction, however oddly a client uses the token.

## What we found

- **Clients put credentials in unexpected slots** (e.g. `Authorization` *and* `?key=`). Forwarding headers as-received leaks the token upstream in the un-routed slot; deleting only the matched slot is not enough.
- **Plaintext in KV is an exfiltration surface** - the dashboard, `wrangler kv`, or a rendering bug could expose live credentials.
- **Stamping usage into the token record races revocation** - a hot-path `put` of the record can resurrect a token the admin just revoked.

## The decision we keep

- **The token rides the SDK's own auth slot** - the client swaps only base URL and key ([provider-routing-by-auth-header.md](provider-routing-by-auth-header.md)).
- **Strip-all-then-set-one** (`swapAuth`): delete every inbound auth slot - the headers and `?key=` on both paths, plus the subprotocol on wss - and set exactly one real key. The slot list has a single owner (`stripAuthSlots`, shared by the HTTP and WS paths), so a new slot is added in one place, not four.
- **Hashed at rest**, plaintext shown once - KV never holds a usable credential.
- **`lastUsed` in a side key** (`<hash>:lu`), never the record - the hot path physically cannot re-enable a revoked token.

Related: [websocket-proxy-auth-slots.md](websocket-proxy-auth-slots.md) (wider wss slot set), [kv-free-tier-write-quota.md](kv-free-tier-write-quota.md) (why the stamp is throttled).
