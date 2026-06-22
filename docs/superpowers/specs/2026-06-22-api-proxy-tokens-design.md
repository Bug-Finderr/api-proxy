# api-proxy — Proxy Tokens Design

- **Date:** 2026-06-22
- **Status:** Approved; implementation in progress
- **Scope:** Replace the three transparent reverse-proxy workers with one token-gated worker plus an embedded admin dashboard. Issue shareable, revocable proxy API-key tokens that map to real provider keys server-side.

> Naming: there is no "v1/v2" product split. This is the `api-proxy` project evolving. The new token-gated worker deploys under its own worker name so it can run alongside the existing transparent proxies during validation; the old `src/{claude,openai,gemini}.ts` files and their tomls are deleted once the new worker is reliable.

---

## 1. Problem

The current proxy is three minimal workers (`src/openai.ts`, `src/claude.ts`, `src/gemini.ts`). Each host-rewrites the request to one upstream and injects a single shared real key. The worker URLs are **unauthenticated** — anyone with a URL uses the owner's real key, with no per-user access control and no revocation.

We want: hand someone a token they plug into their normal SDK (changing only the base URL + the key), have it work, and be able to revoke or scope that token at any time from a dashboard — all without exposing the real provider keys.

## 2. Goals

- A consumer uses their existing SDK by changing **two things**: the base URL (point at the worker) and the API key (use a proxy token).
- The owner mints, scopes (per provider), disables, and deletes tokens from an admin dashboard.
- Real provider keys never leave the worker and never live in KV.
- Support OpenAI, Anthropic, and Google Gemini, including streaming, for server-side SDK usage.

## 3. Non-goals (deferred — see §11)

Rate limits, spend/token caps, expiry dates, per-token usage analytics, browser/CORS support, Gemini file uploads, multiple real keys per provider, instant (sub-minute) revocation.

## 4. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Mechanism | Proxy token = the API key the SDK already sends. Worker reads it from the auth header, validates against KV, swaps in the real key. | Unifies "shareable key" and "common-ground SDK config"; client changes only base URL + key. |
| Topology | One worker, one base URL, **no provider path prefix**. Provider routing by which auth header the token arrives in (+ path for Gemini OpenAI-compat). | A `/openai` `/anthropic` `/gemini` prefix breaks Gemini native file uploads. The auth header already identifies the provider. |
| Architecture | **Single worker, embedded.** Top-level dispatch: `/admin/*` → Hono admin sub-app (wrapped in try/catch); everything else → framework-free proxy hot-path. | Proxy requests pay zero routing/SSR cost. Avoids two deploys / two secret sets / broken `schedule.sh`. Escape hatch: move `src/admin/*` to a second worker on the same KV namespace if it ever outgrows CRUD. |
| Token storage | Store **SHA-256(token)** in KV; show plaintext once at creation; dashboard shows label + last-4. | Foundational, hard to retrofit. A KV/dashboard dump yields unusable hashes. Standard practice. |
| Real keys | One real key per provider, env **secret**, shared by all tokens for that provider. | Token is an access/revocation handle, not a routing key to different accounts. |
| Admin stack | **Hono + JSX fragments + HTMX 2.x** (HTMX loaded from CDN, browser-side only — zero bytes in the Worker bundle). Pin HTMX 2.x (4.0 is alpha; do not adopt). | Concise, embeds as a one-line sub-app, ~14KB. Heavy frameworks (SvelteKit/Astro/React Router) own the entrypoint, force a 2nd worker, and add 50-500KB+. |
| Test runner | **Vitest `^4.1.0`** + `@cloudflare/vitest-pool-workers` (0.16.x). nub has no built-in runner; `nub run test` invokes vitest. | Cloudflare-supported path; runs inside workerd. |
| Package manager | **nub** (`nubjs.com`); lockfile `lock.yaml` (pnpm v9 format). | Project standard. |

## 5. Architecture & module layout

One worker, dispatched by path:

```
fetch(req, env, ctx):
  if pathname startsWith "/admin":  try { adminApp.fetch(req, env, ctx) } catch { 500 }
  else:                             proxyHandler(req, env, ctx)
```

- **State:** one KV namespace, `TOKENS`. Key = `SHA-256(token)` (hex). Value = `TokenMetadata` (§7).
- **Secrets** (only these four): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ADMIN_SECRET`. Never in KV, never returned to callers.
- **Plain vars (NOT secrets):** `OPENAI_UPSTREAM`, `ANTHROPIC_UPSTREAM`, `GEMINI_UPSTREAM` — default to the real hosts; overridable for tests (§6, §Testing).

```
src/
  index.ts        # fetch entry + dispatch
  proxy.ts        # ZERO framework deps: extractToken, routeProvider, swapAuth, stream passthrough. MUST NOT import Hono.
  tokens.ts       # KV helpers: sha256hex, generateToken (ptk_ + 32 base64url), create, list, getValidated, update, delete, touchLastUsed
  upstreams.ts    # UPSTREAM resolver: reads *_UPSTREAM env with real-host defaults; parses protocol+hostname+port (the test seam)
  types.ts        # shared TokenMetadata, Provider types (imported by proxy + admin)
  admin/
    index.ts      # new Hono(); mounts routes; HMAC cookie auth middleware
    routes.tsx    # GET/POST/PUT/DELETE /admin/api/tokens (HTML fragments); GET /admin; /admin/login, /admin/logout
    layout.tsx    # <AdminLayout> shell; loads HTMX 2.x from CDN; minimal inline CSS (no Tailwind JIT)
    components.tsx # <TokenTable>, <TokenRow>, <AddTokenCard>, <TokenCreatedOnce>
test/
  proxy.test.ts          # TIER 1 (vitest-pool-workers)
  sdk-compat/
    setup.ts             # TIER 2 harness: mock upstream (node:http) + unstable_startWorker + capture helpers
    openai.test.ts
    anthropic.test.ts
    gemini.test.ts
vitest.config.ts         # cloudflare pool (tier 1)
vitest.compat.config.ts  # node pool, --pool=forks (tier 2)
wrangler.toml            # ONE config: name='api-proxy', [[kv_namespaces]] binding='TOKENS'
schedule.sh              # kept
```

Deleted once the new worker is verified reliable: `src/openai.ts`, `src/claude.ts`, `src/gemini.ts`, `wrangler.openai.toml`, `wrangler.claude.toml`, `wrangler.gemini.toml`.

## 6. Request flow (proxy path)

```
1. extractToken(req, url)
     x-api-key  ||  x-goog-api-key  ||  Authorization: "Bearer X" -> X  ||  ?key=
     none -> 401 "missing token"
2. provider = routeProvider(req, url)            // §6.1
3. rec = getValidated(KV, sha256hex(token))
     miss || status != "active" -> 401 "invalid or revoked token"
4. coarse(provider) not in rec.providers -> 403 "token not allowed for provider"
5. swapAuth: delete x-api-key, x-goog-api-key, authorization; set the ONE real key
6. resolve upstream: u = parse(UPSTREAM[provider]); url.protocol=u.protocol; url.hostname=u.hostname; url.port=u.port
   if provider startsWith "gemini": url.searchParams.delete("key")
7. fetch(new Request(url, { method, headers, body }))   // path + query verbatim
8. return new Response(upstream.body, upstream)          // stream straight through, no buffering
9. ctx.waitUntil(touchLastUsed(KV, hash))                // fire-and-forget
```

### 6.1 Provider routing table

| Token arrives in | + path signal | Provider | Upstream (default, overridable) | Real key set as |
|---|---|---|---|---|
| `x-api-key` | — | `anthropic` | `ANTHROPIC_UPSTREAM` = `api.anthropic.com` | `x-api-key` |
| `x-goog-api-key` or `?key=` | — | `gemini` | `GEMINI_UPSTREAM` = `generativelanguage.googleapis.com` | `x-goog-api-key` |
| `Authorization: Bearer` | path starts `/v1beta/openai/` | `gemini-openai` | `GEMINI_UPSTREAM` | `Authorization: Bearer` |
| `Authorization: Bearer` | else | `openai` | `OPENAI_UPSTREAM` = `api.openai.com` | `Authorization: Bearer` |

`routeProvider` returns one of `openai | anthropic | gemini | gemini-openai`. The provider-scope check (step 4) and the token's `providers` array use the coarse set `openai | anthropic | gemini`, so `gemini-openai` maps to the `gemini` scope. The `gemini` vs `gemini-openai` distinction only selects the swap branch in §6.2.

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

Stripping-all-then-setting-one prevents the proxy token leaking upstream and closes the Anthropic dual-header leak and the duplicate-`x-goog-api-key` 401.

## 7. Token model & lifecycle

KV: `SHA-256(token)` (hex) →

```ts
type TokenMetadata = {
  label: string;
  last4: string;
  providers: ("openai" | "anthropic" | "gemini")[];
  status: "active" | "disabled";
  createdAt: string;   // ISO
  lastUsed?: string;   // ISO
  // reserved for Later (absent in v1): expiresAt, limits, spend
};
```

- **Create:** admin supplies label + provider scopes, types a token or clicks generate (`ptk_` + 32 random base64url from `crypto.getRandomValues`). Worker stores `sha256hex(token) -> metadata`, returns the **plaintext once**. Never retrievable again.
- **List/Update/Delete:** by hash. Update edits label, providers, status (`active` ⇄ `disabled`).
- **last-used:** fire-and-forget KV write on each successful proxied request.

> Revocation latency: KV is eventually consistent (~up to 60s). Acceptable for v1; instant revocation via Durable Object is a Later item.

## 8. Admin dashboard

Embedded **Hono** sub-app, server-rendered **JSX fragments + HTMX 2.x** (HTMX from CDN; no client JS we write; no UI/charting libs in the bundle).

- **Auth:** single `ADMIN_SECRET` password → `POST /admin/login` sets an HMAC-SHA256-signed cookie `cm_admin=<ts>.<sig>`, `HttpOnly; SameSite=Strict; Max-Age=86400`. Middleware guards all `/admin/*` except login.
- **Routes:** HTMX-driven CRUD — `hx-get/post/put/delete` on `/admin/api/tokens`, `hx-swap="outerHTML"` on rows for create/edit/delete/enable-disable. `GET /admin` dashboard, `GET /admin/logout`.
- **UI:** add-token card (token field + generate, label, provider checkboxes), token table (label, last-4, provider pills, created, last-used, edit/delete). Plaintext token shown once after creation.
- **Blast-radius:** the dispatcher wraps `adminApp.fetch` in try/catch returning a plain 500, so an admin bug can never crash the proxy branch.

## 9. Real key handling

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` are Cloudflare secrets resolved at request time and injected only into the outbound request. Never logged, never in KV, never in a response body.

## 10. Gotchas handled in v1

1. **SSE streaming** — pass `upstream.body` straight through; never `await response.text()`. Preserve upstream `cache-control: no-transform`; no response-buffering features; ensure the zone isn't re-compressing `text/event-stream`.
2. **Verbatim path + query forwarding** — only protocol/host/port are rewritten; path and query (incl. Gemini `?alt=sse`) stay intact.
3. **Strip-all-then-set-one auth** (§6.2).
4. **Gemini `?key=` hygiene** — keep `url.searchParams.delete("key")` for raw-REST/curl callers.
5. **Hostname** — do not issue worker hostnames ending in `.openai.azure.com`, `.services.ai.azure.com`, `.cognitiveservices.azure.com`.

## 11. Deferred (Later)

KV value shape + module boundaries leave room; none built now: rate limits, spend/token caps (parse `usage`; OpenAI needs `stream_options.include_usage`), expiry, per-token analytics, browser/CORS preflight, Gemini file uploads (forward `x-goog-upload-url`), multiple real keys per provider, instant revocation + atomic counters via Durable Object.

## 12. Testing (two-tier harness)

Do not test proxy logic and real-SDK HTTP behavior with one tool — conflating them is the main flakiness source.

**Tier 1 — proxy logic (always-on CI gate, ~1s):** `@cloudflare/vitest-pool-workers` inside workerd (`vitest.config.ts`).
- Seed KV directly: `env.TOKENS.put(sha256hex(token), JSON.stringify(meta))`.
- Capture the outbound call with `vi.spyOn(globalThis, "fetch")`; assert: (a) right upstream host, (b) real key swapped in AND proxy token absent (`.not.toContain(token)` on all three header slots), (c) path+query verbatim, (d) 401 on missing/invalid/revoked, 403 on provider-scope mismatch.
- SSE: mocked fetch returns a `ReadableStream` `text/event-stream`; drive via `createExecutionContext()`/`waitOnExecutionContext()`; read `response.body.getReader()` chunk-by-chunk; assert content-type preserved and chunks un-buffered. Tier 1 does not use the upstream env seam (it mocks fetch entirely).

**Tier 2 — real-SDK compatibility (feature-branch + pre-deploy, ~10-20s):** `vitest.compat.config.ts`, Node pool, `--pool=forks`, serial.
- `wrangler unstable_startWorker` starts a real HTTP listener (not the deprecated `unstable_dev`).
- A `node:http` mock upstream captures the raw inbound request; point the worker's `*_UPSTREAM` env at it (the seam earns its keep).
- Seed the token via the worker's own `POST /admin/api/tokens` (also exercises create).
- Run the real `openai`, `@anthropic-ai/sdk`, `@google/genai` packages with `baseURL` = local worker and `apiKey` = proxy token. Assert on the captured request: real key present, proxy token absent, exact path the SDK constructed (catches `:generateContent`, `/v1beta/openai`).
- SSE: mock writes `text/event-stream` chunks; consume via the SDK's own stream iterator; assert on connection-start headers, not the buffered body (avoids mid-stream-disconnect races).

**Flakiness guards:** Tier 2 serial (shared mutable capture state + port); never `await body.text()/json()` in the proxy path; use the SDK's stream iterator for completion, not `setTimeout`.

## 13. Dev commands (nub) & rollout

```
nub install                      # install all deps (CI: nub ci)
nub add hono                     # runtime dep
nub add -E -D vitest@^4.1.0 @cloudflare/vitest-pool-workers @cloudflare/workers-types
nub add -E -D openai @anthropic-ai/sdk @google/genai   # tier-2 SDKs
nub run dev                      # "dev": wrangler dev   (or: nubx wrangler dev)
nub run test:unit                # vitest run --config vitest.config.ts
nub run test:compat              # vitest run --config vitest.compat.config.ts --pool=forks
nub run test                     # test:unit && test:compat
```

Rollout: (1) build under `name = "api-proxy"` (distinct from the old `*-proxy` workers); (2) create KV namespace, set the four secrets, mint a test token, verify each SDK end-to-end incl. streaming; (3) once reliable, delete the three old `src/*.ts` + tomls. **README is stale** (shows `bun`/`bunx`) — update to nub + `lock.yaml`.

## 14. Bloat-watch (single-worker discipline)

The single-worker choice is only safe with discipline:
- `proxy.ts` MUST NOT import Hono or admin code — the hot-path stays framework-free pure functions.
- No npm UI/component libraries, charting libs, or Tailwind JIT output in the admin — server-rendered HTML + HTMX attributes + minimal inline CSS only (these bundle into the same worker and inflate cold-start).
- Keep the upstream seam to exactly three vars with real-host defaults; do not generalize into a routing/rewrite config.
- Pin HTMX 2.x; pin vitest `^4.1.0` with current `@cloudflare/vitest-pool-workers` 0.16.x.

## 15. Open items to verify during implementation

- Exact base-URL strings per SDK (esp. Vercel AI SDK Anthropic, whose provider default includes `/v1`) — confirmed at test time; the worker forwards verbatim so it's robust either way.
- Gemini OpenAI-compat coverage (`/v1beta/openai/chat/completions`) before documenting it as the recommended Python-Gemini path.
- KV propagation delay — measure to decide whether a short in-worker cache + bust-on-revoke is worth adding before the Durable-Object Later item.
