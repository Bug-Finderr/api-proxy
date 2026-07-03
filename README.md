# api-proxy

A single Cloudflare Worker that reverse-proxies the OpenAI, Anthropic, and Google Gemini APIs — over **HTTP and WebSocket** — behind **revocable proxy tokens**. You issue tokens from an admin dashboard and hand them out; each token is validated server-side and swapped for the real provider key before the request is forwarded. Consumers never see your real keys, and you can scope or revoke any token at any time.

## Use it

Works with the official **OpenAI**, **Anthropic**, and **Google GenAI** SDKs (Python and Node) — and, since the worker routes by auth header and forwards verbatim, with anything that speaks those APIs: the Vercel AI SDK, LangChain, LiteLLM, OpenAI-compatible tools, or raw `curl`. A client changes only **two things**: the base URL and the API key (a proxy token).

| Client | base URL | API key |
|---|---|---|
| OpenAI SDK (Python / Node) | `https://<worker>/v1` | proxy token |
| Anthropic SDK (Python / Node) | `https://<worker>` (no `/v1`) | proxy token |
| Google `@google/genai` (Node) | `httpOptions.baseUrl = https://<worker>` | proxy token |
| Gemini via the OpenAI SDK | `https://<worker>/v1beta/openai` | proxy token |

```python
# OpenAI SDK (Python); Node is identical
from openai import OpenAI
client = OpenAI(base_url="https://<worker>/v1", api_key="<proxy-token>")
client.chat.completions.create(
    model="gpt-5.4", messages=[{"role": "user", "content": "Hello"}])
```

Or raw HTTP:

```bash
curl https://<worker>/v1/chat/completions \
  -H "authorization: Bearer <proxy-token>" -H "content-type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'
```

Browser apps work too — the worker answers the CORS preflight and reflects the request Origin (provider browser opt-ins still apply, e.g. Anthropic's `dangerouslyAllowBrowser`).

### WebSocket / realtime

Realtime sockets proxy the same way — point the WebSocket at the worker and use a proxy token. The worker swaps the token for the real key on the upgrade handshake.

| WebSocket API | URL | token slot |
|---|---|---|
| OpenAI Realtime (server) | `wss://<worker>/v1/realtime?model=…` | `Authorization: Bearer <proxy-token>` |
| OpenAI Realtime (browser) | `wss://<worker>/v1/realtime?model=…` | `Sec-WebSocket-Protocol: realtime, openai-insecure-api-key.<proxy-token>` |
| OpenAI Responses (WebSocket mode) | `wss://<worker>/v1/responses` | `Authorization: Bearer <proxy-token>` |
| Gemini Live | `wss://<worker>/ws/…BidiGenerateContent?key=<proxy-token>` | `?key=` query |

A browser can't set the `Authorization` header on a WebSocket, so OpenAI smuggles the key in the `openai-insecure-api-key.` subprotocol — the worker reads it there and re-presents it as a Bearer header upstream. Anthropic has no WebSocket API. A long-lived socket is rate-limited and validated **once at connect**, so a revoke applies to the next connection, not an open stream.

## How it works

The proxy token rides in the SDK's normal auth slot. The worker validates it, checks it's scoped to the requested provider, strips every inbound auth header, sets the one real key, and forwards the request (path + query verbatim, streaming included). Routing is by which auth header the token arrives in — see [docs/architecture.md](docs/architecture.md) for the routing table and full design.

## Setup

```bash
nub install
nubx wrangler login
nubx wrangler kv namespace create TOKENS   # paste the id into wrangler.toml
```

Set the secrets (only these four; never committed):

```bash
nubx wrangler secret put OPENAI_API_KEY
nubx wrangler secret put ANTHROPIC_API_KEY
nubx wrangler secret put GEMINI_API_KEY
nubx wrangler secret put ADMIN_SECRET     # password for the admin dashboard
nubx wrangler deploy
```

Optional plain vars (NOT secrets) override the upstreams; they default to the real hosts and only need setting for testing: `OPENAI_UPSTREAM`, `ANTHROPIC_UPSTREAM`, `GEMINI_UPSTREAM`.

## Admin dashboard

Visit `https://<worker>/admin`, sign in with `ADMIN_SECRET`, and create tokens: give each a label, the providers it may use (OpenAI / Anthropic / Gemini), an optional expiry, and either type a token or generate one. The token is shown **once** at creation — copy it then; only its SHA-256 hash is stored. Disable or delete any token instantly.

## Per-token controls

- **Expiry** — optionally set an expiry at creation; past it the token is rejected and the dashboard shows it as `expired`.
- **Rate limit** — each token is capped at 100 requests / 60s (`429` + `Retry-After` over the limit). Tune `[[ratelimits]]` in `wrangler.toml`. It is a per-colo, loose ceiling for abuse protection, not a strict quota.
- **Scope & revoke** — a token only reaches the providers you check; disable or delete to revoke (KV propagation is up to ~60s).

## Security

- Real provider keys are Cloudflare secrets, injected only into outbound requests — never in KV, never returned to callers.
- Tokens are stored as SHA-256 hashes; a KV/dashboard dump yields unusable hashes, not live tokens.
- The worker strips all inbound auth headers before setting the real key, so a proxy token is never forwarded upstream.
- Do not host the worker on a `*.openai.azure.com` / `*.cognitiveservices.azure.com` domain (the OpenAI SDK switches to Azure auth on those hostnames).

## Testing

```bash
nub run test:unit     # tier 1: proxy logic in workerd (vitest-pool-workers), fast CI gate
nub run test:compat   # tier 2: real client libs (official SDKs, Vercel AI SDK, LangChain, Genkit) + raw fetch + a real wss round-trip vs a mock upstream
nub run test:py       # tier 2 (Python): LiteLLM, LlamaIndex, instructor, Pydantic AI through the worker (needs the venv below)
nub run test          # all of the above
```

Tier 2 starts the real worker (`unstable_dev`) with `*_UPSTREAM` pointed at a `node:http` mock, seeds a token via the admin API, drives each real client, and asserts the forwarded request carries the real key (and never the token). The Python runner (`test/run-py.mjs`) owns the same worker + mock and runs each `*.py` as a thin client. **Each file in `test/sdk-compat/` is named after the package it drives and doubles as a usage example** — copy the `baseURL`/`apiKey` wiring from the file matching your client (e.g. `ai-sdk-openai.ts`, `langchain-anthropic.ts`, `genkit.ts`, `pydantic-ai.py`), from `fetch.ts` for raw HTTP, or from `websocket.ts` for a wss client.

**What's tested, and what's by-construction.** The worker routes by *which auth slot a request uses*, not by SDK — so a provider's packages behave identically once the slot is fixed. We therefore test **each distinct library once, in one language** — the official `openai` / `@anthropic-ai/sdk` / `@google/genai` SDKs, the Vercel AI SDK, LangChain, Genkit, LiteLLM, LlamaIndex, instructor, and Pydantic AI (see `test/sdk-compat/`) — and treat the rest as compatible-by-construction: a tested SDK's other-language packages (`openai-python`/`-go`/`-java`/...), end-user apps (Aider, Cline, Continue, Open WebUI), and JVM/.NET frameworks (Spring AI, Semantic Kernel) each reuse a slot already proven. The per-provider proof matrix is in [docs/learnings/compat-is-the-auth-slot-not-the-sdk.md](docs/learnings/compat-is-the-auth-slot-not-the-sdk.md). Two gotchas: use Anthropic's normal API-key mode (its OAuth `authToken` mode sends `Bearer`, which would route to OpenAI), and the legacy `google-generativeai` Python SDK needs `transport="rest"` (it defaults to gRPC and won't traverse an HTTP proxy otherwise).

The Python runner uses a local venv. One-time setup with [uv](https://docs.astral.sh/uv/):

```bash
uv venv
uv pip install -r test/requirements.txt
```

> **Gemini is untested with the actual API.** No test hits a live provider — all three run against a mock upstream. OpenAI and Anthropic are additionally verified live in deployment; Gemini is **not**, because `GEMINI_API_KEY` isn't set yet, so the Gemini route has never run against the real Google Generative Language API. Treat it as built-but-unproven until a key is added.

## Cost

Cloudflare Workers free tier covers this (100k requests/day). You only pay upstream providers for API usage.

## Contributing

Issues are welcome. External PRs are not accepted and will be auto-closed.
