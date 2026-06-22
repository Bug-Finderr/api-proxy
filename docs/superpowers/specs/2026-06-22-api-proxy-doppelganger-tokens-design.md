# api-proxy — Doppelganger Tokens Design

- **Date:** 2026-06-22
- **Status:** Approved (design); implementation pending
- **Scope:** Replace the three transparent reverse-proxy workers with one token-gated worker plus an admin dashboard. Issue shareable, revocable "doppelganger" API-key tokens that map to real provider keys server-side.

> Naming note: there is no "v1/v2" product split. This is the `api-proxy` project evolving. The new token-gated worker deploys under its own worker name so it can run alongside the existing transparent proxies during validation; the old `src/{claude,openai,gemini}.ts` files and their tomls are deleted once the new worker is reliable.

---

## 1. Problem

The current proxy is three minimal workers (`src/openai.ts`, `src/claude.ts`, `src/gemini.ts`). Each host-rewrites the request to one upstream and injects a single shared real key. The worker URLs are **unauthenticated** — anyone with a URL uses the owner's real key, with no per-user access control and no revocation. Sharing access safely is impossible.

We want: hand someone a token they plug into their normal SDK (changing only the base URL + the key), have it work, and be able to revoke or scope that token at any time from a dashboard — all without exposing the real provider keys.

## 2. Goals

- A consumer uses their existing SDK by changing **two things**: the base URL (point at the worker) and the API key (use a doppelganger token).
- The owner mints, scopes (per provider), disables, and deletes tokens from an admin dashboard.
- Real provider keys never leave the worker and never live in KV.
- Support OpenAI, Anthropic, and Google Gemini, including streaming, for server-side SDK usage.

## 3. Non-goals (deferred — see §11)

Rate limits, spend/token caps, expiry dates, per-token usage analytics, browser/CORS support, Gemini file uploads, multiple real keys per provider, instant (sub-minute) revocation.

## 4. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Mechanism | Doppelganger token = the API key the SDK already sends. Worker reads it from the auth header, validates against KV, swaps in the real key. | Unifies "shareable key" and "common-ground SDK config" into one mechanism; client changes only base URL + key. |
| Topology | One worker, one base URL, **no provider path prefix**. | A `/openai` `/anthropic` `/gemini` prefix breaks Gemini native file uploads (the SDK drops path prefixes when building resumable upload URLs — js-genai #709; Python rewrites host only). A prefix is unnecessary because the auth header already identifies the provider. |
| Provider routing | By which auth header the token arrives in (+ path for the Gemini OpenAI-compat case). | `Authorization: Bearer`→OpenAI, `x-api-key`→Anthropic, `x-goog-api-key`→Gemini. Resolves the `/v1/models` collision for free. |
| Token storage | Store **SHA-256(token)** in KV; show plaintext once at creation; dashboard shows label + last-4. | Foundational, hard to retrofit. A KV/dashboard dump yields unusable hashes, not live tokens. Standard practice (Stripe/OpenAI/OpenRouter). |
| Real keys | One real key per provider, env secret, shared by all tokens for that provider. | Token is an access/revocation handle, not a routing key to different accounts. Key pools deferred. |
| Stack | Single worker, **Hono + JSX** dashboard, **KV** for tokens, **nub** as package manager. | Mirrors the proven `cheating-mommy/cloud` pattern; nub already installed. |

## 5. Architecture

One worker, dispatched by path:

```
fetch(req):
  /admin/*  -> admin handler (cookie-gated dashboard + token CRUD)
  else      -> token-gated reverse proxy
```

- **State:** one KV namespace, `TOKENS`. Key = `SHA-256(token)` (hex). Value = token metadata JSON (§7).
- **Secrets:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ADMIN_SECRET` — Cloudflare secrets, never in KV, never returned to callers.

### Module layout
- `src/index.ts` — fetch entry + path dispatch.
- `src/proxy.ts` — token extraction, provider routing, KV validation, auth swap, forwarding.
- `src/tokens.ts` — KV helpers: hash, create, list, get-validated, update, delete; token generation.
- `src/admin/` — Hono sub-app: cookie auth (HMAC), pages (JSX), token CRUD API.
- `wrangler.toml` — one config; `name = "api-proxy"`, `[[kv_namespaces]]` binding, secrets via `wrangler secret put`.
- `schedule.sh` — kept (enable/disable a worker by toggling `workers_dev`).
- Deleted once reliable: `src/openai.ts`, `src/claude.ts`, `src/gemini.ts`, `wrangler.openai.toml`, `wrangler.claude.toml`, `wrangler.gemini.toml`.

## 6. Request flow (proxy path)

```
1. extractToken(req, url)
     x-api-key  ||  x-goog-api-key  ||  Authorization: "Bearer X" -> X  ||  ?key=
     none -> 401 "missing token"
2. provider = routeProvider(req, url)            // §6.1
3. rec = getValidated(KV, sha256(token))
     miss || status != "active" -> 401 "invalid or revoked token"
4. if provider not in rec.providers -> 403 "token not allowed for provider"
5. swapAuth: delete x-api-key, x-goog-api-key, authorization; set the ONE real key
6. url.hostname = UPSTREAM[provider]; url.protocol = "https:"
   if provider startsWith "gemini": url.searchParams.delete("key")
7. fetch(new Request(url, { method, headers, body }))   // path + query verbatim
8. return new Response(upstream.body, upstream)          // stream straight through
9. ctx.waitUntil(touchLastUsed(KV, hash))                // fire-and-forget
```

### 6.1 Provider routing table

| Token arrives in | + path signal | Provider key | Upstream host | Real key set as |
|---|---|---|---|---|
| `x-api-key` | — | `anthropic` | `api.anthropic.com` | `x-api-key` |
| `x-goog-api-key` or `?key=` | — | `gemini` | `generativelanguage.googleapis.com` | `x-goog-api-key` |
| `Authorization: Bearer` | path starts `/v1beta/openai/` | `gemini-openai` | `generativelanguage.googleapis.com` | `Authorization: Bearer` |
| `Authorization: Bearer` | else | `openai` | `api.openai.com` | `Authorization: Bearer` |

`routeProvider` returns one of `openai | anthropic | gemini | gemini-openai`. The provider-scope check (step 4) and the token's `providers` array use the coarse set `openai | anthropic | gemini`, so `gemini-openai` maps to the `gemini` scope. The `gemini` vs `gemini-openai` distinction only selects the swap branch in §6.2 (different auth header).

### 6.2 Auth swap (security linchpin)

Always **strip all three** inbound auth headers, then set exactly one:

```ts
headers.delete("x-api-key");
headers.delete("x-goog-api-key");
headers.delete("authorization");
switch (provider) {
  case "openai":        headers.set("authorization", `Bearer ${realKey}`); break;
  case "anthropic":     headers.set("x-api-key", realKey); break;
  case "gemini":        headers.set("x-goog-api-key", realKey); break;
  case "gemini-openai": headers.set("authorization", `Bearer ${realKey}`); break;
}
```

Stripping-all-then-setting-one prevents the doppelganger token leaking upstream and closes the Anthropic dual-header (`apiKey` + `authToken`) leak and the duplicate-`x-goog-api-key` 401 seen with some integration layers.

## 7. Token model & lifecycle

KV: `SHA-256(token)` (hex) → 

```json
{
  "label": "alice-laptop",
  "last4": "9f3c",
  "providers": ["openai", "anthropic"],
  "status": "active",
  "createdAt": "2026-06-22T10:00:00.000Z",
  "lastUsed": "2026-06-22T12:30:00.000Z"
}
```

Reserved for Later (written as `undefined`/absent in v1, no logic depends on them): `expiresAt`, `limits`, `spend`.

- **Create:** admin supplies a label, provider scopes, and either types a token or clicks generate (`dgk_` + 32 random base64url chars from `crypto.getRandomValues`). Worker stores `sha256(token) -> metadata`, returns the **plaintext once**. Never retrievable again.
- **List:** `KV.list()` → each value rendered (no plaintext token, only `last4`).
- **Update:** edit label, providers, status (`active` ⇄ `disabled`) by hash.
- **Delete:** remove the hash key.
- **last-used:** fire-and-forget KV write on each successful proxied request.

> Revocation latency: KV is eventually consistent (propagation up to ~60s). A disabled/deleted token may still work briefly. Acceptable for v1; instant revocation via Durable Object is a Later item.

## 8. Admin dashboard

Direct port of the `cheating-mommy/cloud` pattern (Hono + JSX, no React):

- **Auth:** single `ADMIN_SECRET` password → `POST /admin/login` sets an HMAC-SHA256-signed cookie `cm_admin=<ts>.<sig>`, `HttpOnly; SameSite=Strict; Max-Age=86400`. Middleware guards all `/admin/*` except login; API routes return JSON 401, page routes render the login form.
- **Routes:** `GET/POST/PUT/DELETE /admin/api/tokens` (CRUD), `GET /admin` (dashboard), `GET /admin/logout`.
- **UI:** add-token card (token field + generate button, label, provider checkboxes for OpenAI/Anthropic/Gemini, status); token table (label, last-4, provider pills, created, last-used, edit/delete). Plaintext token surfaced once in a copy field right after creation.

## 9. Real key handling

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` are Cloudflare secrets resolved at request time and injected only into the outbound request. Never logged, never in KV, never in a response body.

## 10. Gotchas handled in v1

1. **SSE streaming** — pass `upstream.body` straight through (`new Response(upstream.body, upstream)`); never `await response.text()`. Preserve upstream `cache-control: no-transform`; do not enable any response-buffering worker feature; ensure the zone is not re-compressing `text/event-stream`.
2. **Verbatim path + query forwarding** — mutate the `URL` object's host/protocol only; keep path and query intact so Gemini's `?alt=sse` and all params survive.
3. **Strip-all-then-set-one auth** (§6.2).
4. **Gemini `?key=` hygiene** — keep `url.searchParams.delete("key")` for raw-REST/curl callers (SDKs use the header).
5. **Hostname** — do not issue worker hostnames ending in `.openai.azure.com`, `.services.ai.azure.com`, or `.cognitiveservices.azure.com` (openai-node auto-switches to Azure auth mode by hostname suffix).

## 11. Deferred (Later)

The KV value shape and module boundaries leave room for these; none are built now:

- Rate limits, spend/token caps (parse provider `usage`; OpenAI needs `stream_options.include_usage`), expiry dates, per-token usage analytics.
- Token hashing is already in v1; **show-once** is in v1.
- Browser/CORS: answer `OPTIONS` preflight and synthesize `Access-Control-Allow-Origin/Headers` (incl. `authorization, x-api-key, x-goog-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, x-stainless-*`).
- Gemini file uploads: forward the `x-goog-upload-url` response header so resumable URLs point back at the worker (host-root requirement already satisfied by the no-prefix design).
- Multiple real keys per provider (key pools / per-token real-key mapping).
- Instant revocation + atomic counters via Durable Object or Cloudflare Rate Limiting binding.

## 12. Client setup (the payoff)

The worker forwards paths verbatim, so it is agnostic to which SDK is used; the only per-SDK difference is the base-URL string the consumer sets. Both `base URL` and `key` can also be set via env vars where the SDK supports it.

| SDK | base URL | key slot | auth header sent |
|---|---|---|---|
| OpenAI (Python / Node) | `https://worker/v1` | token | `Authorization: Bearer` |
| Anthropic (Python / Node) | `https://worker` (no `/v1`) | token | `x-api-key` |
| Gemini (Node `@google/genai`) | `httpOptions.baseUrl = https://worker` (or `GOOGLE_GEMINI_BASE_URL`) | token | `x-goog-api-key` |
| Gemini from Python | point the **OpenAI** SDK at `https://worker/v1beta/openai` | token | `Authorization: Bearer` |
| Vercel AI SDK | `createOpenAI({baseURL:'…/v1'})`, `createAnthropic({baseURL:'…/v1'})`, `createGoogleGenerativeAI({baseURL:'…/v1beta'})` | token | per provider |

> Why Gemini-from-Python uses the OpenAI-compat path: the native `google-genai` Python SDK has **no base-URL env var** and requires an `http_options=HttpOptions(base_url=…)` constructor object (a third code change). Routing Gemini through the OpenAI SDK against `/v1beta/openai` keeps it to the same two-line change.

## 13. Rollout & deprecation

1. Build the new worker; deploy under `name = "api-proxy"` (distinct from `openai-proxy`/`claude-proxy`/`gemini-proxy`) so existing proxies keep running.
2. Create the KV namespace; set the four secrets; mint a test token per provider; verify each SDK end-to-end (incl. streaming).
3. Once reliable, delete the three old `src/*.ts` files and three tomls; the new worker is the proxy.

## 14. Open items to verify during implementation

- **Exact base-URL strings per SDK** in §12 — confirm against each SDK at test time (especially Vercel AI SDK Anthropic, whose provider default base URL includes `/v1`, unlike the native Anthropic SDK). The worker is robust either way since it forwards verbatim; this only affects the setup docs.
- **Gemini OpenAI-compat coverage** — confirm `/v1beta/openai/chat/completions` (and embeddings) behave through the swap before documenting it as the recommended Python-Gemini path.
- **KV propagation delay** — measure actual disable/delete latency to decide whether a short in-worker `caches` TTL + bust-on-revoke is worth adding before the Durable-Object Later item.
