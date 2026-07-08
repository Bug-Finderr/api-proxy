# Token expiry: check-at-validate, not KV TTL

## Problem

Optional per-token expiry, enforced cheaply, without a second storage backend.

## What we found

- **KV `expirationTtl` is the wrong tool:** 60s floor, it *deletes* the record on expiry (so the dashboard can't show an "expired" row), and it orphans the separate `<hash>:lu` last-used key.
- `expiresAt` is set once and never mutates, so a check at read time has no consistency window - it is exact and adds zero extra reads (the field rides in the JSON already fetched to validate).

## The decision we keep

Store optional `expiresAt` (UTC ISO); enforce in `getValidatedByHash`:

```ts
if (meta.expiresAt) {
  const t = Date.parse(meta.expiresAt);
  if (Number.isNaN(t)) return null; // fail-closed on malformed
  if (t <= Date.now()) return "expired"; // sentinel -> callers answer 401 "token expired"
}
```

**Fail-closed on malformed input:** `NaN <= Date.now()` is `false`, which fails *open* (a garbage `expiresAt` stays valid) - so `Number.isNaN(t)` is checked explicitly. The past-expiry case returns a distinct sentinel so the proxy can answer `401 token expired` instead of the generic invalid-token message: expiry is the one failure a correctly-configured client will eventually hit, so it should self-diagnose. The admin form converts its local `datetime-local` value to UTC ISO in the browser; the route rejects unparseable or offset-less input at creation (an offset-less string would be read in the runtime's timezone, not the admin's).

Related: [proxy-token-security.md](proxy-token-security.md).
