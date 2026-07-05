# api-proxy — Architecture

A single Cloudflare Worker (Free plan) that reverse-proxies **OpenAI, Anthropic, and Google Gemini** behind shareable, revocable **proxy tokens**. A client changes only its base URL and API key; the worker validates the token, swaps in the real provider key server-side, and forwards the request verbatim. The real key never leaves Cloudflare.

This document is the current design. Topic deep-dives with the "why" live in [`docs/learnings/`](learnings/); the retired one-worker-per-provider v1 lives in [`_legacy/v1/`](../_legacy/v1/).

---

## 1. Problem

v1 was three unauthenticated workers (one per provider), each injecting a shared real key for **anyone** who knew the URL — no per-user access, no revocation. v2 collapses them into one token-gated worker.

## 2. Topology

One worker, dispatched in `src/index.ts`:

- **WebSocket upgrade** (`Upgrade: websocket`) → `handleWsProxy`, the wss hot path (§10), checked first so a realtime client never falls through to the HTTP branch.
- **`/admin/*`** → the Hono admin sub-app, wrapped in `try/catch` (→ 500) so an admin bug can never crash the proxy branch.
- **everything else** → `handleProxy`, the framework-free hot path (`src/proxy.ts` must never import Hono — it is pure functions plus a `fetch` handler).

## 3. Request flow (proxy hot path)

`handleProxy` is a thin wrapper: it answers an `OPTIONS` preflight directly, otherwise runs `proxyRequest` and reflects CORS headers onto the result (§8). `proxyRequest`:

1. **Extract** the token from whichever auth slot it arrived in and **route** the provider from that slot (+ path); missing either → **401**. (§4)
2. **Validate** `SHA-256(token)` against KV — a miss, a disabled token, or an expired one → **401**. (§6)
3. Requested provider not in the token's scope → **403**. (§4)
4. **Rate-limit** on the hash — over the cap → **429** + `Retry-After` (fail-open). (§7)
5. **Rewrite** the URL to the upstream — protocol/host/port only; strip `?key=` for Gemini. (§13)
6. **Swap auth** — strip every inbound auth header, set the one real key. (§5)
7. **Fetch** the upstream (OpenAI adds a geo-403 fallback, §9), stream the response back unbuffered, and stamp `lastUsed` fire-and-forget. (§6, §9)

## 4. Provider routing (by auth header)

The client adds no path prefix and no custom header — routing reads **which auth slot the SDK populated** (`routeProvider`, `extractToken`):

| Inbound signal | Provider | Upstream |
|---|---|---|
| `x-api-key` | `anthropic` | api.anthropic.com |
| `x-goog-api-key` or `?key=` | `gemini` | generativelanguage.googleapis.com |
| `Authorization: Bearer` + path `/v1beta/openai/*` | `gemini-openai` | generativelanguage.googleapis.com |
| `Authorization: Bearer` (else) | `openai` | api.openai.com |
| none | — | 401 |

Auth slots are checked **before** `?key=`, so a request carrying `Authorization: Bearer` routes to openai / gemini-openai even when it also has `?key=`; the `x-goog-api-key or ?key=` equivalence holds only when no Bearer header is present.

`gemini-openai` (the OpenAI-compatible Gemini endpoint) collapses to the `gemini` scope via `coarse()`; the distinction only selects the auth-swap branch. **Why no `/openai` `/anthropic` path prefix:** it would break Gemini's file-upload flow (absolute `x-goog-upload-url` round trip) and force every client to rewrite the SDK's own base path. See [`provider-routing-by-auth-header.md`](learnings/provider-routing-by-auth-header.md).

## 5. Auth swap (security linchpin)

Before forwarding, `swapAuth` deletes **every** inbound auth header and sets exactly one with the real key:

```ts
headers.delete("x-api-key"); headers.delete("x-goog-api-key"); headers.delete("authorization");
switch (provider) {
  case "openai": case "gemini-openai": headers.set("authorization", `Bearer ${realKey}`); break;
  case "anthropic":                    headers.set("x-api-key", realKey);                  break;
  case "gemini":                       headers.set("x-goog-api-key", realKey);             break;
}
```

Strip-all-then-set-one guarantees the proxy token is never forwarded upstream even if a client sends it in an unexpected slot, and closes dual-header leaks. A test asserts the token never appears in any outbound auth header. See [`proxy-token-security.md`](learnings/proxy-token-security.md).

## 6. Token model & lifecycle

KV namespace `TOKENS`, keyed by `SHA-256(token)` (hex). The plaintext is shown **once** at creation and never persisted (`src/tokens.ts`, `src/types.ts`):

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

- **Tokens** are opaque: `ptk_` + 32 url-safe chars (24 random bytes). Custom admin-typed tokens are allowed; validation is by hash of the full string.
- **Validation** (`getValidatedByHash`): returns the record only if `status === "active"` AND, when `expiresAt` is set, it parses to a future timestamp — malformed or past expiry is rejected **fail-closed**. Not KV `expirationTtl` (60s floor, silently deletes the record, orphans the `:lu` key) — see [`token-expiry-check-at-validate.md`](learnings/token-expiry-check-at-validate.md).
- **`lastUsed`** lives in a separate `<hash>:lu` key, stamped fire-and-forget at most once per UTC day per token (date-only column; free-tier KV allows 1,000 writes/day account-wide). Keeping it out of the token record means stamping it can never resurrect or re-enable a token the admin just disabled or deleted.
- **Lifecycle:** `createToken`, `listTokens` (paginates KV, skips `:lu` keys), `updateToken` (label / providers / status), `deleteToken` (record + `:lu`). KV is eventually consistent (~60s), so revoke and new-token visibility can lag.

## 7. Per-token rate limiting

After validation, `RATE_LIMITER.limit({ key: hash })` (the Workers Rate Limiting binding) caps each token. Over the limit → `429` + `Retry-After: 60`. Wrapped in try/catch and **fail-open**: a missing or erroring binding must never brick the proxy.

```toml
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 100        # one shared ceiling for all tokens; tune freely
  period = 60        # must be 10 or 60
```

It is in-process (not a subrequest), keyed on the hash, and **per-colo + eventually consistent** — a loose ceiling for abuse protection, not a strict quota. Verified to run on the Free plan. See [`rate-limit-binding-free-and-loose.md`](learnings/rate-limit-binding-free-and-loose.md).

## 8. CORS & browser support

`handleProxy` short-circuits `OPTIONS` to a `204` preflight **before** the token checks (a preflight carries no auth header, so it would otherwise 401 and block every browser SDK). The preflight reflects the request `Origin`, reflects the requested `Access-Control-Request-Headers`, advertises a fixed method allow-list (`GET, POST, PUT, DELETE, OPTIONS`), and sets `Access-Control-Max-Age: 86400`. Every real response then passes through `withCors`, which reflects `Origin`, appends `Vary: Origin` (so per-Origin reflection is cache-safe), and exposes the Gemini resumable-upload headers (`x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity`). No `Origin` → no CORS headers (server-side callers are unaffected). Credentials mode is never enabled (SDKs send keys as headers, not cookies). Provider browser opt-ins still apply (e.g. Anthropic's `dangerouslyAllowBrowser`, which the SDK forwards as a header).

**Gemini file uploads** pass through verbatim: the start call routes normally, Google returns an absolute, self-authenticating `x-goog-upload-url`, and the client uploads bytes **directly to Google** — that leg never transits the worker, so the 100 MB body cap is sidestepped and the real key is never on it.

## 9. OpenAI geo-403 egress (North-America-pinned Durable Object)

OpenAI 403s `unsupported_country_region_territory` when a request egresses from an unsupported colo (e.g. Hong Kong). A Worker's `fetch()` egresses from the colo the invocation runs in, fixed per invocation, so an in-invocation retry can't escape a bad colo.

The fix is a fallback: try the fast edge `fetch()` first (requests that egress from a good colo return immediately); **only on the geo-403**, re-issue the same request through the `UsEgress` SQLite Durable Object pinned to North America (`locationHint: "wnam"`). Running in a US colo, its `fetch()` egresses from a supported region and succeeds. Only the OpenAI branch buffers the body (to replay it to the DO); a pool of DO ids spreads load. Anthropic and Gemini are untouched, and the real key never leaves Cloudflare. See [`openai-egress-geo-block.md`](learnings/openai-egress-geo-block.md).

## 10. WebSocket (wss) proxying

The token-swap model extends to WebSocket upgrades (`src/ws.ts`, `handleWsProxy`), dispatched before the HTTP branch on `Upgrade: websocket`. It serves the realtime/streaming sockets the HTTP APIs don't cover: **OpenAI** `/v1/realtime` and `/v1/responses` (WebSocket mode), and **Gemini Live** (`...BidiGenerateContent`). Anthropic has no wss API, so it is naturally excluded.

The flow mirrors the HTTP path — extract token → validate hash → scope check → rate-limit → swap auth — then opens the upstream socket with `fetch(target, { Upgrade: websocket })` (the scheme stays `http(s):`; the header drives the upgrade), reads `resp.webSocket`, and pumps frames both ways through a `WebSocketPair`. It's a **manual pipe** (not a transparent pass-through) so the subprotocol the upstream negotiates is echoed back to the client deterministically — a browser handshake fails if the server picks none of the offered subprotocols. A non-101 upstream handshake (401/403/426) is surfaced to the client verbatim rather than as a generic error.

**Auth on a WS handshake has a wider slot set than HTTP**, because a browser `WebSocket` cannot set request headers, so providers smuggle the key elsewhere:

| Inbound slot | Provider | Swapped to (upstream) |
|---|---|---|
| `Authorization: Bearer <token>` | openai | `Authorization: Bearer <real>` |
| `Sec-WebSocket-Protocol: openai-insecure-api-key.<token>` | openai | key entry dropped; real key set as `Authorization: Bearer` (the worker *can* set headers); `realtime` + org/project/beta subprotocols kept |
| `?key=<token>` | gemini | `?key=<real>` in the query (Gemini Live reads the key there, not a header) |

`prepareWsUpstream` strips every inbound auth slot then sets exactly one — the WS analogue of `swapAuth` (§5) — so the proxy token never reaches the upstream in any slot (header, query, or subprotocol); a test asserts this. The OpenAI **geo-403 fallback (§9) applies here too**: a 403 from a bad colo re-issues the upgrade through the `UsEgress` DO. (The DO carries a WebSocket like a plain `fetch`; this reuses HTTP's egress path, though the geo-blocked WS hop itself isn't locally testable.)

Caveats: the rate limit gates the **connection**, not each frame (one upgrade = one hit); a revoke takes effect on the next connection, not mid-stream (a long-lived socket is validated once, at upgrade time); and Cloudflare closes an idle socket after a quiet period, so a silent client should keep-alive. See [`websocket-proxy-auth-slots.md`](learnings/websocket-proxy-auth-slots.md).

## 11. Admin dashboard

Embedded **Hono** sub-app at `/admin` (`src/admin/`), server-rendered HTML via `hono/html` plus **HTMX 2.x** loaded from a CDN (zero client JS we author; nothing in the worker bundle but markup + attributes).

- **Auth:** one `ADMIN_SECRET` password. `POST /admin/login` sets an HMAC-SHA256-signed cookie `cm_admin=<ts>.<sig>` (`Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`). A middleware guards every `/admin/*` route except login; the signature check uses constant-time `crypto.subtle.verify`.
- **CRUD:** HTMX-driven over `/admin/api/tokens` — list (`GET`), create (`POST`; parses label, provider checkboxes, an optional `datetime-local` expiry normalized to UTC ISO, custom-or-generated token), edit / enable-disable (`PUT`), delete (`DELETE`). `:hash` params are validated as 64-hex.
- **UI:** an add-token card (label, token, **Expires (optional)**, provider checkboxes) and a token table (label, last-4, provider pills, status, **Expires**, last-used, disable/delete). The created plaintext is shown once; expired tokens render `expired` and dim the row. The list refreshes on load, on the `tokens-changed` event, and **every 10 s** (to surface new tokens / last-used despite KV's ~60 s list propagation).

## 12. Real key handling

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ADMIN_SECRET` are Cloudflare **secrets**, read at request time and injected only into the outbound request. Never logged, never stored in KV, never returned in a response body. The CORS and rate-limit paths never touch a real key.

## 13. Storage, bindings & config (`wrangler.toml`)

| Binding | Kind | Purpose |
|---|---|---|
| `TOKENS` | KV namespace | token store (by `SHA-256`) + `:lu` last-used keys |
| `US_EGRESS` | SQLite Durable Object (`UsEgress`) | NA-pinned egress fallback for OpenAI (HTTP + wss) |
| `RATE_LIMITER` | Rate Limit | per-token RPM ceiling |

Plus `[[migrations]] tag="v1" new_sqlite_classes=["UsEgress"]`. Upstreams resolve through `upstreamBase()`: the `*_UPSTREAM` env vars (plain vars, not secrets) default to the real hosts and are overridden only by tests pointing at a mock; `rewriteToUpstream` rewrites just protocol/host/port.

## 14. Testing (two tiers)

| Tier | Runner | Scope |
|---|---|---|
| 1 — proxy logic | `@cloudflare/vitest-pool-workers` (workerd) | routing, auth swap, expiry, CORS, rate limit, geo-403 fallback, SSE passthrough, **WS upgrade + subprotocol auth swap** (`test/ws.test.ts`); mocks `fetch`, seeds KV directly |
| 2 — real client libs | `unstable_dev` worker + `node:http` mock upstream (Node via vitest; Python via `test/run-py.mjs`) | official `openai`/`@anthropic-ai/sdk`/`@google/genai` SDKs, Vercel AI SDK, LangChain, Genkit, LiteLLM, LlamaIndex, instructor, Pydantic AI, and a **real wss round-trip** (`websocket.ts`: `ws` client → worker → `ws` mock) — end-to-end |

Tier 2 covers every auth slot — OpenAI (`Bearer`, `openai.ts` + `litellm.py`), Anthropic (`x-api-key`, `anthropic-ai-sdk.ts`), Gemini native (`x-goog-api-key`, `google-genai.ts`), Gemini OpenAI-compat (the OpenAI SDK at `/v1beta/openai`, `google-genai.ts`), and the Gemini `?key=` query slot plus verbatim path/query/body forwarding (`fetch.ts`) — plus streaming for the main three; OpenAI-compat streaming rides the same SSE passthrough, so it has no dedicated test. Each asserts the real key reaches the mock and the token never does. Compatibility is fixed by the **auth slot, not the SDK or language**, so each distinct library gets **one** end-to-end test in one language; a provider's other-language packages (`openai-python`/`-go`/...), end-user apps (Aider, Cline, Continue, Open WebUI), and JVM/.NET frameworks (Spring AI, Semantic Kernel) reuse a slot already proven and are documented rather than re-tested — see [`compat-is-the-auth-slot-not-the-sdk.md`](learnings/compat-is-the-auth-slot-not-the-sdk.md). **No test hits a live provider** (mock upstream only): OpenAI/Anthropic are verified live in deployment, but **Gemini has never run against the real Google API** (no key yet).

## 15. Deployment

```bash
nub install
nubx wrangler kv namespace create api-proxy-tokens   # paste id into wrangler.toml
nubx wrangler secret put OPENAI_API_KEY              # + ANTHROPIC / GEMINI / ADMIN_SECRET
nubx wrangler deploy
```

Free Workers plan covers it (100k req/day); you only pay upstream providers for usage.

## 16. Security model

Invariants are detailed in §5 (auth swap), §6 (token hashing, revoke-safe `lastUsed`), §11 (admin HMAC cookie), and §12 (real-key handling).

Caveats:

- KV is ~60s eventually consistent, so a revoke / expiry-flip is not instant — for an immediate cutoff, rotate the provider secret (instant, and the key stays in Cloudflare).
- Do not host on `*.openai.azure.com` / `*.cognitiveservices.azure.com` (the OpenAI SDK switches to Azure auth on those hostnames).

## 17. Deferred / future

The token data model leaves room (`limits`, `spend`) without carrying the weight now: spend / token-count caps + per-token usage analytics (needs a metering Durable Object and SSE usage parsing), multiple real keys per provider (key pools), concurrency limits and longer rate-limit windows, and instant (sub-minute) revocation via a DO allow/deny list.
