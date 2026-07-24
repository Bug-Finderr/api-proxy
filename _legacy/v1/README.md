# v1 - one worker per provider

The original design used three unauthenticated Workers, one for each provider. Each Worker rewrote the host and injected its own provider secret.

| Worker | Upstream | Credential set |
|---|---|---|
| `openai-proxy` | api.openai.com | Bearer |
| `claude-proxy` | api.anthropic.com | `x-api-key` |
| `gemini-proxy` | generativelanguage.googleapis.com | `x-goog-api-key` |

## Why it was replaced

Anyone who knew a Worker URL could spend its shared provider key. There were no per-user scopes, revocation, or usage controls, and each provider needed a separate URL and deployment.

The current root Worker adds hashed proxy tokens, one routing surface, and the OpenAI geo-block fallback. See the active [architecture](../../docs/architecture.md).

## Status

Historical reference only. This directory is excluded from builds and tests and is not maintained as deployable code.
