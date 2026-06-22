# api-proxy

A single Cloudflare Worker that reverse-proxies the OpenAI, Anthropic, and Google Gemini APIs behind **revocable "doppelganger" tokens**. You issue tokens from an admin dashboard and hand them out; each token is validated server-side and swapped for the real provider key before the request is forwarded. Consumers never see your real keys, and you can scope or revoke any token at any time.

The consumer changes only **two things** in their normal SDK: the base URL (point at your worker) and the API key (use a doppelganger token).

## How it works

The doppelganger token rides in the SDK's normal auth slot. The worker reads it, validates it against KV, checks the token is scoped to the requested provider, strips every inbound auth header, sets the one real key, and forwards the request (path + query verbatim, streaming included).

| Token arrives in | Provider | Upstream | Real key set as |
|---|---|---|---|
| `Authorization: Bearer` | OpenAI | `api.openai.com` | `Authorization: Bearer` |
| `x-api-key` | Anthropic | `api.anthropic.com` | `x-api-key` |
| `x-goog-api-key` / `?key=` | Gemini | `generativelanguage.googleapis.com` | `x-goog-api-key` |
| `Authorization: Bearer` + path `/v1beta/openai/*` | Gemini (OpenAI-compat) | `generativelanguage.googleapis.com` | `Authorization: Bearer` |

## Client setup

Point the SDK's base URL at the worker and use a doppelganger token as the key:

| SDK | base URL | key |
|---|---|---|
| OpenAI (Python / Node) | `https://<worker>/v1` | token |
| Anthropic (Python / Node) | `https://<worker>` (no `/v1`) | token |
| Google `@google/genai` (Node) | `httpOptions.baseUrl = https://<worker>` | token |
| Gemini from Python | point the **OpenAI** SDK at `https://<worker>/v1beta/openai` | token |

```bash
# OpenAI-style
curl https://<worker>/v1/chat/completions \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'
```

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

Visit `https://<worker>/admin`, sign in with `ADMIN_SECRET`, and create tokens: give each a label, the providers it may use (OpenAI / Anthropic / Gemini), and either type a token or generate one. The token is shown **once** at creation — copy it then; only its SHA-256 hash is stored. Disable or delete any token instantly.

## Security

- Real provider keys are Cloudflare secrets, injected only into outbound requests — never in KV, never returned to callers.
- Tokens are stored as SHA-256 hashes; a KV/dashboard dump yields unusable hashes, not live tokens.
- The worker strips all inbound auth headers before setting the real key, so a doppelganger token is never forwarded upstream.
- Do not host the worker on a `*.openai.azure.com` / `*.cognitiveservices.azure.com` domain (the OpenAI SDK switches to Azure auth on those hostnames).

## Testing

Two tiers (Vitest):

```bash
nub run test:unit     # tier 1: proxy logic in workerd (vitest-pool-workers), fast CI gate
nub run test:compat   # tier 2: real openai / @anthropic-ai/sdk / @google/genai SDKs vs a local worker + mock upstream
nub run test          # both
```

Tier 2 starts the real worker (`unstable_dev`) with `*_UPSTREAM` pointed at a `node:http` mock, seeds a token via the admin API, then drives each real SDK and asserts the forwarded request carries the real key (and never the token).

## Disable / Enable

`schedule.sh` toggles the worker's `workers_dev` URL without deleting it:

```bash
./schedule.sh disable          # now
./schedule.sh disable +30m     # in 30 minutes
./schedule.sh enable 22:00     # at 10pm
```

## Cost

Cloudflare Workers free tier covers this (100k requests/day). You only pay upstream providers for API usage.

## Contributing

Issues are welcome. PRs are not accepted and will be auto-closed.
