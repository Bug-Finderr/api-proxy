# api-proxy — Architecture

A single Cloudflare Worker (Free plan) that reverse-proxies **OpenAI, Anthropic, and Google
Gemini** behind shareable, revocable **proxy tokens**. A client changes only its base URL and API
key; the worker validates the token, swaps in the real provider key server-side, and forwards the
request verbatim. The real key never leaves Cloudflare.

This document is the current design. Topic deep-dives with the "why" live in
[`docs/learnings/`](learnings/); the retired one-worker-per-provider v1 lives in
[`_legacy/v1/`](../_legacy/v1/).

---

## 1. Problem

v1 was three unauthenticated workers (one per provider), each injecting a shared real key for
**anyone** who knew the URL — no per-user access, no revocation. v2 collapses them into one
token-gated worker.

## 2. Topology

One worker, dispatched by path (`src/index.ts`):

```
/admin/*   →  Hono admin sub-app   (wrapped in try/catch → 500)
*          →  handleProxy()        (framework-free hot path)
```

The admin sub-app is isolated in a `try/catch` so an admin bug can never crash the proxy branch. The
proxy hot path imports **no framework** — pure functions plus a `fetch` handler (`src/proxy.ts` must
never import Hono).

## 3. Request flow (proxy hot path)

`handleProxy` is a thin wrapper: it answers `OPTIONS` preflights (§8) and reflects `Origin` on every
response. Everything else runs `proxyRequest`:

1. **Extract + route** — read the token from its auth slot, pick the provider from that slot (+ path) (§4). No token or provider → **401**.
2. **Validate** — `getValidatedByHash(SHA-256(token))`; must be active and unexpired (§6). Else → **401**.
3. **Scope** — `coarse(provider)` must be in the token's `providers`. Else → **403**.
4. **Rate limit** — `RATE_LIMITER.limit({ key: hash })`, per-token, fail-open (§7). Over the limit → **429** + `Retry-After`.
5. **Rewrite** — swap protocol/host/port only; strip `?key=` for Gemini (§12).
6. **Swap auth** — strip every inbound auth header, set the one real key (§5).
7. **Forward** — `fetch` the upstream; OpenAI retries via the egress DO on a geo-403 (§9).
8. **Return** — stream the response back unbuffered (SSE preserved); `ctx.waitUntil(touchLastUsed)` (§6).

## 4. Provider routing (by auth header)

The client adds no path prefix and no custom header — routing reads **which auth slot the SDK
populated** (`routeProvider`, `extractToken`):

| Inbound signal | Provider | Upstream |
|---|---|---|
| `x-api-key` | `anthropic` | api.anthropic.com |
| `x-goog-api-key` or `?key=` | `gemini` | generativelanguage.googleapis.com |
| `Authorization: Bearer` + path `/v1beta/openai/*` | `gemini-openai` | generativelanguage.googleapis.com |
| `Authorization: Bearer` (else) | `openai` | api.openai.com |
| none | — | 401 |

`gemini-openai` (the OpenAI-compatible Gemini endpoint) collapses to the `gemini` scope via
`coarse()`; the distinction only selects the auth-swap branch. **Why no `/openai` `/anthropic` path
prefix:** it would break Gemini's file-upload flow (absolute `x-goog-upload-url` round trip) and
force every client to rewrite the SDK's own base path. See
[`provider-routing-by-auth-header.md`](learnings/provider-routing-by-auth-header.md).

## 5. Auth swap (security linchpin)

Before forwarding, `swapAuth` deletes **every** inbound auth header and sets exactly one with the
real key:

```ts
headers.delete("x-api-key"); headers.delete("x-goog-api-key"); headers.delete("authorization");
switch (provider) {
  case "openai": case "gemini-openai": headers.set("authorization", `Bearer ${realKey}`); break;
  case "anthropic":                    headers.set("x-api-key", realKey);                  break;
  case "gemini":                       headers.set("x-goog-api-key", realKey);             break;
}
```

Strip-all-then-set-one guarantees the proxy token is never forwarded upstream even if a client sends
it in an unexpected slot, and closes dual-header leaks. A test asserts the token never appears in any
outbound auth header. See [`proxy-token-security.md`](learnings/proxy-token-security.md).

## 6. Token model & lifecycle

KV namespace `TOKENS`, keyed by `SHA-256(token)` (hex). The plaintext is shown **once** at creation
and never persisted (`src/tokens.ts`, `src/types.ts`):

```ts
type TokenMetadata = {
  label: string;
  last4: string;                                   // for display
  providers: ("openai"|"anthropic"|"gemini")[];    // coarse scope
  status: "active" | "disabled";
  createdAt: string;                               // ISO
  expiresAt?: string;                              // ISO (UTC); absent = never expires
};
```

- **Tokens** are opaque: `ptk_` + 32 url-safe chars (24 random bytes). Custom admin-typed tokens are
  allowed; validation is by hash of the full string.
- **Validation** (`getValidatedByHash`): returns the record only if `status === "active"` AND, when
  `expiresAt` is set, it parses to a future timestamp — malformed or past expiry is rejected
  **fail-closed**. Not KV `expirationTtl` (60s floor, silently deletes the record, orphans the `:lu`
  key) — see [`token-expiry-check-at-validate.md`](learnings/token-expiry-check-at-validate.md).
- **`lastUsed`** lives in a separate `<hash>:lu` key, written fire-and-forget per proxied request.
  Keeping it out of the token record means stamping it can never resurrect or re-enable a token the
  admin just disabled or deleted.
- **Lifecycle:** `createToken`, `listTokens` (paginates KV, skips `:lu` keys), `updateToken`
  (label / providers / status), `deleteToken` (record + `:lu`). KV is eventually consistent (~60s),
  so revoke and new-token visibility can lag.

## 7. Per-token rate limiting

After validation, `RATE_LIMITER.limit({ key: hash })` (the Workers Rate Limiting binding) caps each
token. Over the limit → `429` + `Retry-After: 60`, wrapped in try/catch and **fail-open** so a
missing or erroring binding can never brick the proxy.

```toml
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"
  [ratelimits.simple]
  limit = 100        # one shared ceiling for all tokens; tune freely
  period = 60        # must be 10 or 60
```

It is in-process (not a subrequest), keyed on the hash, and **per-colo + eventually consistent** — a
loose ceiling for abuse protection, not a strict quota. Verified to run on the Free plan. See
[`rate-limit-binding-free-and-loose.md`](learnings/rate-limit-binding-free-and-loose.md).

## 8. CORS & browser support

`handleProxy` short-circuits `OPTIONS` to a `204` preflight **before** the token checks (a preflight
carries no auth header, so it would otherwise 401 and block every browser SDK). The preflight
reflects the request `Origin` and the requested `Access-Control-Request-Headers`, and sets
`Access-Control-Max-Age: 86400`. Every real response then passes through `withCors`, which reflects
`Origin` and exposes the Gemini resumable-upload headers (`x-goog-upload-url`, `x-goog-upload-status`,
`x-goog-upload-chunk-granularity`). No `Origin` → no CORS headers (server-side callers unaffected).
Credentials mode is never enabled (SDKs send keys as headers, not cookies). Provider browser opt-ins
still apply (e.g. Anthropic's `dangerouslyAllowBrowser`, which the SDK forwards as a header).

**Gemini file uploads** pass through verbatim: the start call routes normally, Google returns an
absolute, self-authenticating `x-goog-upload-url`, and the client uploads bytes **directly to
Google** — that leg never transits the worker, so the 100 MB body cap is sidestepped and the real key
is never on it.

## 9. OpenAI geo-403 egress (North-America-pinned Durable Object)

OpenAI 403s `unsupported_country_region_territory` when a request egresses from an unsupported colo
(e.g. Hong Kong). A Worker's `fetch()` egresses from the colo the invocation runs in, fixed per
invocation, so an in-invocation retry can't escape a bad colo. The fix:

1. Direct edge `fetch` → `200` → return (the fast path, ~60% of calls).
2. On a geo-403 **only** → re-issue through the `wnam`-pinned `UsEgress` DO — a SQLite Durable Object that runs in North America, so its `fetch()` egresses from a supported region → `200` → return.

Only the OpenAI branch buffers the body (so it can be replayed to the DO); a pool of DO ids spreads
load. Anthropic and Gemini are untouched, and the real key never leaves Cloudflare. See
[`openai-egress-geo-block.md`](learnings/openai-egress-geo-block.md).

## 10. Admin dashboard

Embedded **Hono** sub-app at `/admin` (`src/admin/`), server-rendered HTML via `hono/html` plus
**HTMX 2.x** from a CDN (no client JS we author; nothing in the worker bundle but markup + attributes).

- **Auth:** one `ADMIN_SECRET` password. `POST /admin/login` sets an HMAC-SHA256-signed cookie
  `cm_admin=<ts>.<sig>` (`HttpOnly; Secure; SameSite=Strict; Max-Age=86400`). A middleware guards
  every `/admin/*` route except login; the signature is checked with constant-time `crypto.subtle.verify`.
- **CRUD:** HTMX-driven over `/admin/api/tokens` — list (`GET`), create (`POST`; label, provider
  checkboxes, optional `datetime-local` expiry normalized to UTC ISO, custom-or-generated token),
  edit / enable-disable (`PUT`), delete (`DELETE`). `:hash` params are validated as 64-hex.
- **UI:** an add-token card and a token table (label, last-4, provider pills, status, expires,
  last-used, disable/delete). The plaintext is shown once; expired tokens render `expired` and dim
  the row. The list refreshes on load, on `tokens-changed`, and **every 10 s** (to surface new
  tokens / last-used despite KV's ~60 s list propagation).

## 11. Real key handling

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ADMIN_SECRET` are Cloudflare **secrets**,
read at request time and injected only into the outbound request. Never logged, never stored in KV,
never returned in a response body. The CORS and rate-limit paths never touch a real key.

## 12. Storage, bindings & config (`wrangler.toml`)

| Binding | Kind | Purpose |
|---|---|---|
| `TOKENS` | KV namespace | token store (by `SHA-256`) + `:lu` last-used keys |
| `US_EGRESS` | SQLite Durable Object (`UsEgress`) | NA-pinned egress fallback for OpenAI |
| `RATE_LIMITER` | Rate Limit | per-token RPM ceiling |

Plus `[[migrations]] tag="v1" new_sqlite_classes=["UsEgress"]`. Upstreams resolve through
`upstreamBase()`: the `*_UPSTREAM` env vars (plain vars, not secrets) default to the real hosts and
are overridden only by tests pointing at a mock; `rewriteToUpstream` rewrites just protocol/host/port.

## 13. Testing (two tiers)

| Tier | Runner | Scope |
|---|---|---|
| 1 — proxy logic | `@cloudflare/vitest-pool-workers` (workerd) | routing, auth swap, expiry, CORS, rate limit, geo-403 fallback, SSE passthrough; mocks `fetch`, seeds KV directly |
| 2 — real SDKs | `unstable_dev` worker + `node:http` mock upstream | the official `openai`, `@anthropic-ai/sdk`, `@google/genai` SDKs end-to-end |

Tier 2 covers all four routing modes — OpenAI (Bearer), Anthropic (`x-api-key`), Gemini native
(`x-goog-api-key`), and Gemini OpenAI-compat (the OpenAI SDK at `/v1beta/openai`) — plus streaming
for the first three; OpenAI-compat streaming rides the same SSE passthrough, so it has no dedicated
test. Each asserts the real key reaches the mock and the token never does. Routing is by auth header
alone, so any standard-auth SDK behaves identically — these four are representative. **No test hits a
live provider** (mock upstream only): OpenAI/Anthropic are verified live in deployment, but **Gemini
has never run against the real Google API** (no key yet).

## 14. Deployment

```bash
nub install
nubx wrangler kv namespace create api-proxy-tokens   # paste id into wrangler.toml
nubx wrangler secret put OPENAI_API_KEY              # + ANTHROPIC / GEMINI / ADMIN_SECRET
nubx wrangler deploy
```

Free Workers plan covers it (100k req/day); you only pay upstream providers for usage.

## 15. Security model

Invariants, detailed above: real keys are secrets injected only outbound (§11); tokens stored as
`SHA-256` (§6); strip-all-then-set-one auth swap (§5); revoke-safe `lastUsed` (§6); admin behind a
constant-time HMAC cookie, isolated from the proxy branch (§10).

Caveats:

- KV is ~60s eventually consistent, so a revoke / expiry-flip is not instant — for an immediate
  cutoff, rotate the provider secret (instant, and the key stays in Cloudflare).
- Do not host on `*.openai.azure.com` / `*.cognitiveservices.azure.com` (the OpenAI SDK switches to
  Azure auth on those hostnames).

## 16. Deferred / future

The token data model leaves room (`limits`, `spend`) without carrying the weight now: spend /
token-count caps + per-token usage analytics (a metering Durable Object + SSE usage parsing), multiple
real keys per provider (key pools), concurrency limits and longer rate-limit windows, and instant
(sub-minute) revocation via a DO allow/deny list.
