# api-proxy

A single Cloudflare Worker that reverse-proxies the OpenAI, Anthropic, and Google Gemini APIs - over **HTTP and WebSocket** - behind **revocable proxy tokens**. You issue tokens from an admin dashboard and hand them out; each token is validated server-side and swapped for the real provider key before the request is forwarded. Consumers never see your real keys, and you can scope or revoke any token at any time.

## Use it

Works with the official **OpenAI**, **Anthropic**, and **Google GenAI** SDKs (Python and Node) - and, since the worker routes by auth header and forwards everything else verbatim, with anything that speaks those APIs: the Vercel AI SDK, LangChain, LiteLLM, OpenAI-compatible tools, or raw `curl`. A client changes only **two things**: the base URL and the API key (a proxy token).

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

Browser apps work too - the worker answers the CORS preflight and reflects the request Origin (provider browser opt-ins still apply, e.g. Anthropic's `dangerouslyAllowBrowser`).

### WebSocket / realtime

Realtime sockets proxy the same way - point the WebSocket at the worker and use a proxy token. The worker swaps the token for the real key on the upgrade handshake.

| WebSocket API | URL | token slot |
|---|---|---|
| OpenAI Realtime (server) | `wss://<worker>/v1/realtime?model=…` | `Authorization: Bearer <proxy-token>` |
| OpenAI Realtime (browser) | `wss://<worker>/v1/realtime?model=…` | `Sec-WebSocket-Protocol: realtime, openai-insecure-api-key.<proxy-token>` |
| OpenAI Responses (WebSocket mode) | `wss://<worker>/v1/responses` | `Authorization: Bearer <proxy-token>` |
| Gemini Live | `wss://<worker>/ws/…BidiGenerateContent?key=<proxy-token>` | `?key=` query |

A browser can't set the `Authorization` header on a WebSocket, so OpenAI places the key in the `openai-insecure-api-key.` subprotocol; the worker rewrites it to a Bearer header upstream. `x-api-key` upgrades route to Anthropic too. A long-lived socket is rate-limited and validated **once at connect**, so a revoke applies to the next connection, not an open stream.

## How it works

The proxy token rides in the SDK's normal auth slot. The worker validates its scope, strips the HTTP header/query auth slots, sets one provider key, and forwards the path, remaining query, body, and stream. WebSocket handshakes add OpenAI's browser subprotocol slot. See [docs/architecture.md](docs/architecture.md) for the routing table and design.

## Setup

Requires Node 24+ and Nub 0.4.7.

```bash
nub install
nubx wrangler login
nubx wrangler kv namespace create api-proxy-tokens   # paste the id into wrangler.toml
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

Visit `https://<worker>/admin`, sign in with `ADMIN_SECRET`, and create tokens with a label, provider scope, optional expiry, and either a custom value (minimum 12 characters) or a generated value. The plaintext is shown **once**. KV stores its SHA-256 hash plus metadata (`label`, `last4`, scope, status, creation/expiry), with `lastUsed` in a side key. The admin route checks for an existing custom-token hash, but KV's read-then-write is not transactional, so do not race identical creations.

## Per-token controls

- **Expiry** - optionally set an expiry at creation; past it the token is rejected and the dashboard shows it as `expired`.
- **Rate limit** - each token is capped at 100 requests / 60s (`429` + `Retry-After` over the limit). Tune `[[ratelimits]]` in `wrangler.toml`. It is a per-location, loose ceiling for abuse protection, not a strict quota.
- **Scope & revoke** - a token only reaches the providers you check; disable or delete to revoke (KV changes can take 60 seconds or more to reach other locations).

## Security

- Real provider keys are Cloudflare secrets, injected only into outbound requests - never in KV, never returned to callers.
- Token plaintext is not persisted; KV stores hashes, metadata, and separate last-used timestamps.
- The worker strips HTTP header/query auth slots and the WebSocket key subprotocol before setting the provider credential, so a proxy token is not forwarded upstream.
- Do not host the worker on a `*.openai.azure.com` / `*.cognitiveservices.azure.com` domain (the OpenAI SDK switches to Azure auth on those hostnames).

## Testing

```bash
nub run test:unit     # tier 1: proxy logic in workerd (vitest-pool-workers), fast CI gate
nub run test:compat   # tier 2: real client libs (official SDKs, Vercel AI SDK, LangChain, Genkit) + raw fetch + a real wss round-trip vs a mock upstream
nub run test:py       # tier 2 (Python): LiteLLM, LlamaIndex, instructor, Pydantic AI through the worker (needs the venv below)
nub run test          # all of the above
```

**Each client-named compatibility case doubles as a usage example.** Keep every client: shared auth-slot routing is only one invariant, while separate cases catch base-URL options, default endpoints, implicit headers, transport choices, and streaming behavior. Copy the wiring from the matching file, `fetch.ts`, or `websocket.ts`. The coverage rationale is [docs/learnings/compat-is-the-auth-slot-not-the-sdk.md](docs/learnings/compat-is-the-auth-slot-not-the-sdk.md); the harness is [docs/architecture.md](docs/architecture.md) §14.

Two gotchas: use Anthropic's normal API-key mode (its OAuth `authToken` mode sends `Bearer`, which would route to OpenAI), and the legacy `google-generativeai` Python SDK needs `transport="rest"` (it defaults to gRPC and won't traverse an HTTP proxy otherwise).

The Python runner uses a local venv. One-time setup with [uv](https://docs.astral.sh/uv/):

```bash
uv venv
uv pip install -r test/requirements.txt
```

> **Gemini is untested with the actual API.** No test hits a live provider - all three run against a mock upstream. OpenAI and Anthropic are additionally verified live in deployment. A `GEMINI_API_KEY` secret is configured, but its validity and the Gemini route have not been verified against the real Google Generative Language API. Treat it as built-but-unproven until that live check passes.

## Cost

The Worker and SQLite Durable Object have separate allowances. Cloudflare's Free Durable Object tier lists **100,000 requests/day** and **13,000 GB-s/day** (pricing page updated 2026-06-19). Each OpenAI geo-block fallback consumes one DO request, and its execution contributes to active duration. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/); upstream API usage is billed by the provider.

## Contributing

Issues are welcome. External PRs are not accepted and will be auto-closed.

## License

[MIT](LICENSE)
