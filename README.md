# api-proxy

Minimal Cloudflare Workers that act as transparent reverse proxies for AI APIs. Each worker rewrites incoming requests to the upstream API and injects the API key server-side, so clients never need (or see) the key.

## Proxies

| Proxy | Upstream | Config | Secret |
|---|---|---|---|
| Claude | `api.anthropic.com` | `wrangler.claude.toml` | `ANTHROPIC_API_KEY` |
| Gemini | `generativelanguage.googleapis.com` | `wrangler.gemini.toml` | `GEMINI_API_KEY` |

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
```

## Disable / Enable

Toggle a worker URL without deleting it:

```bash
# Disable Claude (URL returns 404, worker stays deployed)
sed -i '' 's/workers_dev = true/workers_dev = false/' wrangler.claude.toml
bunx wrangler deploy --config wrangler.claude.toml

# Re-enable
sed -i '' 's/workers_dev = false/workers_dev = true/' wrangler.claude.toml
bunx wrangler deploy --config wrangler.claude.toml
```

### Schedule

```bash
./schedule.sh disable 22:00              # disable Claude at 10pm
./schedule.sh enable 08:00               # re-enable Claude at 8am
./schedule.sh disable +30m               # disable Claude in 30 minutes
./schedule.sh --gemini disable 22:00     # disable Gemini at 10pm
```

If the time has already passed today, it schedules for tomorrow. Output includes the PID to cancel and a log path to check results.

## Cost

Cloudflare Workers free tier covers this (100k requests/day, no credit card required). You only pay for API usage with the upstream providers.

## Security

- API keys are stored as Cloudflare secrets (encrypted at rest, never in code)
- Keys are only injected into outbound requests, never returned to callers
- **Note:** Worker URLs are unauthenticated — anyone with the URL can use your API key (without seeing it). Keep URLs private or add a bearer token check
