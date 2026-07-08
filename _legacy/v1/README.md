# v1 - one worker per provider (archived)

The original proxy: **three separate Workers**, one per provider, each a thin pass-through
that swaps the hostname and injects the real key from its own secret.

```
client ──▶ openai-proxy  ──(Bearer OPENAI_API_KEY)──▶ api.openai.com
client ──▶ claude-proxy  ──(x-api-key ANTHROPIC_KEY)─▶ api.anthropic.com
client ──▶ gemini-proxy  ──(x-goog-api-key GEMINI)──▶ generativelanguage.googleapis.com
```

| File | Worker | Upstream | Key slot it sets |
|---|---|---|---|
| `openai.ts` / `wrangler.openai.toml` | `openai-proxy` | api.openai.com | `Authorization: Bearer` |
| `claude.ts` / `wrangler.claude.toml` | `claude-proxy` | api.anthropic.com | `x-api-key` |
| `gemini.ts` / `wrangler.gemini.toml` | `gemini-proxy` | generativelanguage.googleapis.com | `x-goog-api-key` (and strips `?key=`) |

## Why it was replaced

- **No auth.** Each worker injected the real upstream key for *any* caller. Anyone who knew
  the URL spent the key. There were no shareable, revocable tokens.
- **Three deploys, three URLs.** Clients had to know which worker maps to which provider, and
  each needed its own secret and deploy.

v2 (the active root worker) collapses all three into **one** worker that routes by auth header,
gates every request behind a hashed [proxy token](../../docs/learnings/proxy-token-security.md),
and adds the [OpenAI geo-403 egress fix](../../docs/learnings/openai-egress-geo-block.md). See
[provider routing by auth header](../../docs/learnings/provider-routing-by-auth-header.md) for how
one base URL serves all three.

## Status

Reference only - **not deployed, not built, not tested.** Kept to document where the project
started. The `main` paths in these tomls point at files in this folder, so each could still be
deployed standalone (`wrangler deploy -c _legacy/v1/wrangler.openai.toml`) if ever needed.
