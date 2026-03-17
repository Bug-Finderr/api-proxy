# api-proxy

Minimal Cloudflare Workers that act as transparent reverse proxies for AI APIs. Each worker rewrites incoming requests to the upstream API and injects the API key server-side, so clients never need (or see) the key.

## Proxies

| Proxy | Upstream | Config | Secret |
|---|---|---|---|
| Claude | `api.anthropic.com` | `wrangler.claude.toml` | `ANTHROPIC_API_KEY` |
| Gemini | `generativelanguage.googleapis.com` | `wrangler.gemini.toml` | `GEMINI_API_KEY` |
| OpenAI | `api.openai.com` | `wrangler.openai.toml` | `OPENAI_API_KEY` |

## Setup

```bash
bun install
bunx wrangler login
```

### Deploy

```bash
# Claude
bunx wrangler secret put ANTHROPIC_API_KEY --config wrangler.claude.toml
bunx wrangler deploy --config wrangler.claude.toml

# Gemini
bunx wrangler secret put GEMINI_API_KEY --config wrangler.gemini.toml
bunx wrangler deploy --config wrangler.gemini.toml

# OpenAI
bunx wrangler secret put OPENAI_API_KEY --config wrangler.openai.toml
bunx wrangler deploy --config wrangler.openai.toml
```

### Usage

Use the worker URL in place of the upstream API. No API key needed in the request:

```bash
# Claude
curl https://<your-worker>.workers.dev/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "claude-sonnet-4-5-20250929", "max_tokens": 256,
       "messages": [{"role": "user", "content": "Hello"}]}'

# Gemini
curl https://<your-worker>.workers.dev/v1beta/models/gemini-3.1-flash-image-preview:generateContent \
  -H "content-type: application/json" \
  -d '{"contents": [{"parts": [{"text": "Hello"}]}]}'

# OpenAI
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model": "gpt-5.4", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Disable / Enable

Toggle or schedule a worker URL without deleting it:

```bash
./schedule.sh disable                             # disable Claude immediately
./schedule.sh --gemini enable                     # enable Gemini immediately
./schedule.sh disable 22:00                       # disable Claude at 10pm today
./schedule.sh disable +30m                        # disable Claude in 30 minutes
./schedule.sh --gemini disable "2026-03-03 01:00" # disable Gemini on a specific date
./schedule.sh --openai disable 23:00              # disable OpenAI at 11pm
```

Time is optional — omit it to run immediately. For `HH:MM`, if the time has already passed today it schedules for tomorrow.

## Cost

Cloudflare Workers free tier covers this (100k requests/day, no credit card required). You only pay for API usage with the upstream providers.

## Security

- API keys are stored as Cloudflare secrets (encrypted at rest, never in code)
- Keys are only injected into outbound requests, never returned to callers
- **Note:** Worker URLs are unauthenticated — anyone with the URL can use your API key (without seeing it). Keep URLs private or add a bearer token check

## Contributing

Issues are welcome. PRs are not accepted and will be auto-closed.