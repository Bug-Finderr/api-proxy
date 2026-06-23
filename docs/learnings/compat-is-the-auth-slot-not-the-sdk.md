# Compatibility is the auth slot, not the SDK

## Problem

Which clients do we need a compat test for? The candidates are endless: the official SDKs in six
languages, the Vercel AI SDK, LangChain (JS + Python), LiteLLM, LlamaIndex, instructor, and every
agent tool (Aider, Cline, Continue, Open WebUI, ...). Writing a test per client would never end, and
most would be copies of each other.

## What we found

The proxy routes and authenticates **purely by which auth slot a request arrives in** plus one path
check; it rewrites only host/port and forwards path + query + body verbatim (`src/proxy.ts`
`routeProvider` / `extractToken`, `src/upstreams.ts` `rewriteToUpstream`). So a client's compatibility
is decided by exactly two things: (1) which of four auth slots it puts the key in, and (2) whether it
lets you point its base URL at an arbitrary host. The SDK, the language, and the wrapper are
irrelevant once those two are fixed.

A source-level survey (official SDK source, provider docs, and wrapper source) confirms every client
collapses onto one of the four already-tested slots. **None hits a new slot or an unhandled path.**

| Provider | Slot the proxy keys on | Clients verified to use it | Wire proof |
|---|---|---|---|
| OpenAI | `Authorization: Bearer` | official SDKs: Python, Node, Go, Java, Ruby, .NET; `@ai-sdk/openai`; `@langchain/openai` (JS+Py); LiteLLM `openai/*`; LlamaIndex OpenAI; instructor; Aider; Cline; Continue; Open WebUI | Python `auth_headers → {"Authorization": f"Bearer {api_key}"}`; Go `Header.Set("authorization", "Bearer "+key)`; Ruby `bearer_auth`; Node sets the same `Authorization: Bearer` header |
| Anthropic | `x-api-key` (+ `anthropic-version`) | official SDKs: Python, Node, Go, Java, Ruby; `@ai-sdk/anthropic`; `@langchain/anthropic` (JS+Py); LlamaIndex Anthropic | every SDK's `auth_headers` sets `x-api-key` and auto-adds `anthropic-version: 2023-06-01` (forwarded verbatim) |
| Gemini (native) | `x-goog-api-key` | `@google/genai` (JS+Py), legacy `@google/generative-ai` / `google-generativeai`; `@ai-sdk/google`; `@langchain/google-genai` (JS+Py); LlamaIndex GoogleGenAI | `@ai-sdk/google` source: `'x-goog-api-key': loadApiKey(...)` — **not** `?key=`, **not** Bearer |
| Gemini (OpenAI-compat) | `Authorization: Bearer` + path `/v1beta/openai/` | any OpenAI SDK pointed at `…/v1beta/openai/` | Google's documented OpenAI-compat surface: `Authorization: Bearer <key>`, `/v1beta/openai/chat/completions` |

Every client also exposes a first-class base-URL override (`base_url` / `baseURL` / `WithBaseURL` /
`OPENAI_BASE_URL` / `httpOptions.baseUrl` / `createX({ baseURL })` / `configuration.baseURL` / ...), so
all can be aimed at the worker.

The existing tier-2 tests already cover all four slots: `openai.ts` + `litellm.py` (Bearer),
`anthropic-ai-sdk.ts` (x-api-key), `google-genai.ts` (x-goog-api-key **and** the `/v1beta/openai/`
Bearer case), `fetch.ts` (the `?key=` query slot **and** verbatim path/query/body forwarding).

## Caveats worth knowing (real divergences, not new slots)

- **Anthropic OAuth/token mode.** Every Anthropic SDK can alternatively authenticate with
  `authToken` / `ANTHROPIC_AUTH_TOKEN`, which sends `Authorization: Bearer` instead of `x-api-key` —
  that would route to the **openai** slot here. Use the normal API-key (`x-api-key`) mode.
- **Legacy `google-generativeai` (Python) defaults to gRPC**, not HTTP, so it won't transit an HTTP
  proxy at all unless you set `transport="rest"`. The current `google-genai` SDK is HTTP by default.
- **OpenAI Responses API path.** Modern OpenAI clients (and the AI SDK 5 default) call `/v1/responses`
  rather than `/v1/chat/completions`. Both are `Authorization: Bearer` and forwarded verbatim, so both
  stay in the openai slot — different upstream endpoint, same proxy behavior.
- **Base-URL `/v1` convention differs per client.** The OpenAI SDK and `@ai-sdk/anthropic` want the
  `/v1` in the base URL; the official `@anthropic-ai/sdk` does **not** (it appends `/v1/messages`
  itself). Set each client's base URL the way that client documents it.

## Decision we keep

Test **one representative client per auth slot** (done) and treat everything else as
compatible-by-construction, documented rather than re-tested. Adding a Vercel AI SDK or per-language
test would only re-exercise an already-covered slot — redundant by the routing logic above. Add a new
test only if a future client hits a genuinely new slot or path (`hitsNewProxyPath`), which nothing in
the current ecosystem does.
