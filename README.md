# claude-proxy

A minimal Cloudflare Worker that acts as a transparent reverse proxy for the [Anthropic API](https://docs.anthropic.com/en/api). It rewrites incoming requests to `api.anthropic.com` and injects your API key server-side, so clients never need (or see) the key.

## How it works

1. Receives any request at the worker URL
2. Rewrites the hostname to `api.anthropic.com` (HTTPS)
3. Replaces the `x-api-key` header with the value from the `ANTHROPIC_API_KEY` secret
4. Forwards the request as-is (method, headers, body) to Anthropic
5. Returns the response directly (streaming-compatible, no buffering)

## Setup

```bash
bun install
```

### Deploy

```bash
# Authenticate with Cloudflare
bunx wrangler login

# Set your Anthropic API key as a secret (will prompt for the value)
bunx wrangler secret put ANTHROPIC_API_KEY

# Deploy the worker
bunx wrangler deploy
```

### Usage

Use the worker URL in place of `api.anthropic.com`. No `x-api-key` needed in the request:

```bash
curl https://<your-worker>.workers.dev/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Disable / Enable

The worker URL can be toggled without deleting the worker by changing `workers_dev` in `wrangler.toml`:

```bash
# Disable (URL returns 404, worker stays deployed)
sed -i '' 's/workers_dev = true/workers_dev = false/' wrangler.toml
bunx wrangler deploy

# Re-enable
sed -i '' 's/workers_dev = false/workers_dev = true/' wrangler.toml
bunx wrangler deploy
```

### Schedule auto-disable

```bash
./schedule.sh disable 22:00    # disable at 10pm
./schedule.sh enable 08:00     # re-enable at 8am
```

If the time has already passed today, it schedules for tomorrow. Output includes the PID to cancel and a log path to check results.

## Cost

Cloudflare Workers free tier covers this comfortably:

| | Free tier |
|---|---|
| Requests | 100,000/day |
| CPU time | 10ms/request |
| Credit card | Not required |

You only pay Anthropic for API usage. The proxy itself is free.

## Security

- The API key is stored as a Cloudflare secret (encrypted at rest, never in code)
- The key is only injected into outbound requests to Anthropic, never returned to callers
- **Note:** The worker URL is unauthenticated — anyone with the URL can use your API key (without seeing it). Keep the URL private or add a bearer token check
