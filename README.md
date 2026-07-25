# api-proxy

A Cloudflare Worker that proxies OpenAI, Anthropic, and Google Gemini over HTTP and WebSocket. Clients use revocable proxy tokens; the Worker validates each token and replaces it with the provider key before forwarding.

## Use it

Clients normally change only their base URL and API key. The compatibility suite covers the official SDKs and selected AI frameworks in `test/sdk-compat/`; other HTTP clients should work when they expose a base-URL override and use a supported credential slot, but are not automatically tested.

| Client                        | Base URL                                 | API key     |
| ----------------------------- | ---------------------------------------- | ----------- |
| OpenAI SDK                    | `https://<worker>/v1`                    | proxy token |
| Anthropic SDK                 | `https://<worker>`                       | proxy token |
| Google `@google/genai`        | `httpOptions.baseUrl = https://<worker>` | proxy token |
| Gemini through the OpenAI SDK | `https://<worker>/v1beta/openai`         | proxy token |

```python
from openai import OpenAI

client = OpenAI(base_url="https://<worker>/v1", api_key="<proxy-token>")
client.chat.completions.create(
    model="gpt-5.6-luna", messages=[{"role": "user", "content": "Hello"}])
```

Browser requests are supported through CORS. Provider-specific browser opt-ins still apply, such as Anthropic's `dangerouslyAllowBrowser`.

### WebSocket APIs

| API              | URL                                                  | Proxy-token slot                                                            |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| OpenAI Realtime  | `wss://<worker>/v1/realtime?model=…`                 | Bearer header, or `openai-insecure-api-key.<token>` subprotocol in browsers |
| OpenAI Responses | `wss://<worker>/v1/responses`                        | Bearer header                                                               |
| Gemini Live      | `wss://<worker>/ws/…BidiGenerateContent?key=<token>` | `?key=` query                                                               |

A socket is authorized and rate-limited when it connects. Revocation affects the next connection, not an open stream.

See [the architecture](docs/architecture.md) for routing, credential replacement, and consistency rules.

## Setup

Requires Node 26+ and Nub 0.5.x.

```bash
nub install
nub exec wrangler login
nub exec wrangler kv namespace create api-proxy-tokens
```

Put the namespace ID in `wrangler.toml`, then configure the secrets and deploy:

```bash
nub exec wrangler secret put OPENAI_API_KEY
nub exec wrangler secret put ANTHROPIC_API_KEY
nub exec wrangler secret put GEMINI_API_KEY
nub exec wrangler secret put ADMIN_SECRET
nub exec wrangler deploy
```

`OPENAI_UPSTREAM`, `ANTHROPIC_UPSTREAM`, and `GEMINI_UPSTREAM` are optional plain variables used mainly to point tests at a mock upstream.

## Admin and token controls

Visit `https://<worker>/admin` and sign in with `ADMIN_SECRET`.

- Create a generated or custom token with a label, provider scope, and optional expiry. Plaintext is shown once.
- Edit expiry, disable a token, or delete it. KV changes may take 60 seconds or more to reach another Cloudflare location.
- Each token is checked against the default 100 requests per 60 seconds threshold, configured under `[[ratelimits]]` in `wrangler.toml`. This is loose per-location abuse control, not a strict quota.

Provider keys stay in Cloudflare secrets. KV stores token hashes and metadata, never usable token plaintext. Before forwarding, the Worker removes every recognized inbound credential slot and sets exactly one provider credential.

Do not host the Worker on an `*.openai.azure.com` or `*.cognitiveservices.azure.com` domain because OpenAI clients may switch to Azure authentication on those hostnames.

## Testing

```bash
nub run test:unit
nub run test:compat
nub run test:py
nub run test
```

Python compatibility tests need a local environment:

```bash
uv venv
uv pip install -r test/requirements.txt
```

The Python tier exits with an error when `.venv` is absent. All automated tests use fake credentials and mock upstreams; Gemini has not been verified against its live API. Client-specific setup and caveats are in [`test/sdk-compat/`](test/sdk-compat/) and the [compatibility learning](docs/learnings/compat-is-the-auth-slot-not-the-sdk.md).

## Cost

The OpenAI geo-block fallback and every admin token create, edit, or delete use a Durable Object request in addition to the Worker request. See [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). Provider API usage is billed separately.

## Contributing

Issues are welcome. External pull requests are auto-closed.

## License

[MIT](LICENSE)
