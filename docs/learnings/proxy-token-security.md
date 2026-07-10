# Proxy token security

## Problem

Share provider access with unmodified SDKs without disclosing the provider key to clients, KV, application logs, or another relay.

## What we found

- **Clients put credentials in unexpected slots** (e.g. `Authorization` *and* `?key=`). Forwarding headers as-received leaks the token upstream in the un-routed slot; deleting only the matched slot is not enough.
- **Plaintext in KV is an exfiltration surface** - the dashboard, `wrangler kv`, or a rendering bug could expose live credentials.
- **Stamping usage into the token record races revocation** - a hot-path `put` of the record can resurrect a token the admin just revoked.

## The decision we keep

- **The token rides the SDK's own auth slot** - the client swaps only base URL and key ([provider-routing-by-auth-header.md](provider-routing-by-auth-header.md)).
- **Strip-all-then-set-one:** `stripAuthSlots` owns the HTTP header/query list and is shared by HTTP and WebSocket paths; `ws.ts` separately removes OpenAI's key-bearing subprotocol entry. Then the proxy sets one provider credential.
- **Hashed at rest:** plaintext is shown once. KV holds the hash and metadata, plus a separate `:lu` timestamp key, never the usable proxy token.
- **`lastUsed` in a side key** (`<hash>:lu`), never the record - the hot path physically cannot re-enable a revoked token.

Related: [websocket-proxy-auth-slots.md](websocket-proxy-auth-slots.md) (wider wss slot set), [kv-free-tier-write-quota.md](kv-free-tier-write-quota.md) (why the stamp is throttled).
