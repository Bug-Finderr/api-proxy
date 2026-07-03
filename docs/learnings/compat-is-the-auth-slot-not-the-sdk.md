# Compatibility is the auth slot, not the SDK

## Problem

Which clients do we need a compat test for? The candidates are endless: the official SDKs in six languages, the Vercel AI SDK, LangChain (JS + Python), LiteLLM, LlamaIndex, instructor, and every agent tool (Aider, Cline, Continue, Open WebUI, ...). Writing a test per client would never end, and most would be copies of each other.

## What we found

The proxy routes and authenticates **purely by which auth slot a request arrives in** plus one path check; it rewrites only host/port and forwards path + query + body verbatim (`src/proxy.ts` `routeProvider` / `extractToken`, `src/upstreams.ts` `rewriteToUpstream`). So a client's compatibility is decided by exactly two things: (1) which auth slot it puts the key in — one of the four the proxy reads (`x-api-key`, `x-goog-api-key`, `Authorization: Bearer`, or the `?key=` query param), with a single path check (`/v1beta/openai/`) splitting Bearer into the openai vs gemini-openai upstream — and (2) whether it lets you point its base URL at an arbitrary host. The SDK, the language, and the wrapper are irrelevant once those two are fixed.

A source-level survey (official SDK source, provider docs, and wrapper source) confirms every client collapses onto one of these already-handled routes. **None hits a new slot or an unhandled path.** The table below lists the four provider routes SDKs actually use (`?key=` is covered after it):

| Provider route | Slot the proxy keys on | Clients verified to use it | Wire proof |
|---|---|---|---|
| OpenAI | `Authorization: Bearer` | official SDKs: Python, Node, Go, Java, Ruby, .NET; `@ai-sdk/openai`; `@langchain/openai` (JS+Py); LiteLLM `openai/*`; LlamaIndex OpenAI; instructor; Aider; Cline; Continue; Open WebUI | Python `auth_headers → {"Authorization": f"Bearer {api_key}"}`; Go `Header.Set("authorization", "Bearer "+key)`; Ruby `bearer_auth`; Node sets the same `Authorization: Bearer` header |
| Anthropic | `x-api-key` (+ `anthropic-version`) | official SDKs: Python, Node, Go, Java, Ruby; `@ai-sdk/anthropic`; `@langchain/anthropic` (JS+Py); LlamaIndex Anthropic | every SDK's `auth_headers` sets `x-api-key` and auto-adds `anthropic-version: 2023-06-01` (forwarded verbatim) |
| Gemini (native) | `x-goog-api-key` | `@google/genai` (JS+Py), legacy `@google/generative-ai` / `google-generativeai`; `@ai-sdk/google`; `@langchain/google-genai` (JS+Py); LlamaIndex GoogleGenAI | `@ai-sdk/google` source: `'x-goog-api-key': loadApiKey(...)` — **not** `?key=`, **not** Bearer |
| Gemini (OpenAI-compat) | `Authorization: Bearer` + path `/v1beta/openai/` | any OpenAI SDK pointed at `…/v1beta/openai/` | Google's documented OpenAI-compat surface: `Authorization: Bearer <key>`, `/v1beta/openai/chat/completions` |

Every client also exposes a first-class base-URL override (`base_url` / `baseURL` / `WithBaseURL` / `OPENAI_BASE_URL` / `httpOptions.baseUrl` / `createX({ baseURL })` / `configuration.baseURL` / ...), so all can be aimed at the worker.

All four slots the proxy reads are exercised end-to-end — the three header slots in the table plus the `?key=` query param (which no SDK uses, only raw HTTP via `fetch.ts`). The full list of tested libraries is in "What we test" below.

## Caveats worth knowing (real divergences, not new slots)

- **Anthropic OAuth/token mode.** Every Anthropic SDK can alternatively authenticate with `authToken` / `ANTHROPIC_AUTH_TOKEN`, which sends `Authorization: Bearer` instead of `x-api-key` — that would route to the **openai** slot here. Use the normal API-key (`x-api-key`) mode.
- **Legacy `google-generativeai` (Python) defaults to gRPC**, not HTTP, so it won't transit an HTTP proxy at all unless you set `transport="rest"`. The current `google-genai` SDK is HTTP by default.
- **OpenAI Responses API path.** Modern OpenAI clients (and the AI SDK 5 default) call `/v1/responses` rather than `/v1/chat/completions`. Both are `Authorization: Bearer` and forwarded verbatim, so both stay in the openai slot — different upstream endpoint, same proxy behavior.
- **Base-URL `/v1` convention differs per client.** The OpenAI SDK and `@ai-sdk/anthropic` want the `/v1` in the base URL; the official `@anthropic-ai/sdk` does **not** (it appends `/v1/messages` itself). Set each client's base URL the way that client documents it.

## What we test, and what we document

Compatibility is the slot, not the language — but a *library* is its own client with its own wiring (base-URL option, default endpoint, extra headers), so each distinct library gets one end-to-end test as a living usage example. We do **not** re-test the same library in every language: a provider's packages share one auth slot (the matrix above), so one language proves them all.

**Tested end-to-end** (`test/sdk-compat/`, each file named after its package):

- Node (`nub run test:compat`): the official `openai`, `@anthropic-ai/sdk`, `@google/genai`; the Vercel AI SDK (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`); LangChain (`@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai`); Genkit (`@genkit-ai/google-genai`); raw `fetch`.
- Python (`nub run test:py`): LiteLLM, LlamaIndex (openai + anthropic + google-genai), instructor, Pydantic AI.

**Documented as compatible-by-construction** (not separately tested) — each collapses onto a slot already proven above:

- **Other-language packages of a tested SDK** — `openai-python` / `-go` / `-java` / `-ruby` / `-dotnet`, `anthropic` (py/go/java/ruby), `google-genai` (py). Same package family, same slot as the JS package already tested; re-testing each language is the redundancy we skip.
- **End-user apps, not importable libraries** — Aider, Cline, Continue, Open WebUI. Each speaks the OpenAI-compatible surface (Bearer slot) with a user-set base URL.
- **JVM / .NET frameworks** — Spring AI, Semantic Kernel. Same slots; no JVM/.NET toolchain in this repo to drive them.
- **Mastra** — `@mastra/core` 1.x is flagged by security advisory MAL-2026-6011 (embedded malicious code), so it is deliberately **not** pulled into the toolchain. It builds on the Vercel AI SDK, so by construction it uses the same Bearer slot already covered by `@ai-sdk/openai`.

A new test is warranted only if a future client hits a genuinely new auth slot or routing path — which nothing in the current ecosystem does.
