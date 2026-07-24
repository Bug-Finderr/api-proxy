# Architecture

`api-proxy` is one Cloudflare Worker for OpenAI, Anthropic, and Google Gemini traffic. It handles HTTP, WebSocket upgrades, and the admin dashboard.

This document describes the current design. [`learnings/`](learnings/) keeps evidence and the reasons behind non-obvious decisions. [`_legacy/v1/`](../_legacy/v1/) is historical reference only.

## Invariants

- Provider keys stay in Cloudflare secrets and are read only after authorization.
- Proxy-token plaintext is shown once and never persisted.
- Every recognized inbound credential slot is removed before exactly one provider credential is set.
- Except for CORS preflight, provider traffic requires an active, unexpired token with the requested provider in scope.
- Automated tests use fake credentials and mock upstreams, never live providers.

## Request flow

`src/index.ts` sends WebSocket upgrades to `src/ws.ts`, `/admin` traffic to the Hono admin app, and other requests to `src/proxy.ts`.

An HTTP request follows this path:

1. Identify the provider and extract the proxy token from the client's normal credential slot.
2. Hash the token and read its metadata from KV.
3. Check status, expiry, provider scope, and the loose per-location rate-limit threshold.
4. Rewrite only the upstream origin, remove all recognized credential slots, and set the selected provider key.
5. Stream the upstream response and schedule a best-effort `lastUsed` stamp.

Missing or invalid tokens return 401, a scope mismatch returns 403, and a rate-limit denial returns 429. A token-store failure returns 503. Rate-limiter failures are fail-open so that the abuse-control layer cannot disable the proxy. Expected 401, 403, and 429 responses are not logged, preventing request-driven log spam.

## Provider identification and credential replacement

Routing uses the credential slot already chosen by the client. This keeps each provider's native path and avoids a proxy-specific path prefix.

| Inbound signal, in precedence order | Provider |
|---|---|
| `x-api-key` | Anthropic |
| `x-goog-api-key` | Gemini |
| Bearer plus `/v1beta/openai/*` | Gemini's OpenAI-compatible API |
| Bearer | OpenAI |
| `?key=` when no earlier slot matched | Gemini |

The OpenAI-compatible Gemini route uses the same token scope as native Gemini.

Before forwarding, the Worker removes Bearer, `x-api-key`, `x-goog-api-key`, and `?key=` credentials, then sets one real provider credential. WebSocket handling also removes OpenAI's key-bearing subprotocol entry. Removing every slot prevents an extra client credential from leaking upstream.

## Tokens and consistency

KV stores token metadata under `SHA-256(token)`. Metadata includes the label, last four characters, provider scope, status, creation time, and optional UTC expiry. Expiry is checked during validation rather than with KV TTL, so expired rows remain visible and the separate usage key is not orphaned. See [the expiry decision](learnings/token-expiry-check-at-validate.md).

`lastUsed` lives in `<hash>:lu`, not in the token record. Updating activity can therefore never rewrite an older token record over a revocation. Stamps are intentionally coarse to stay within the Free-plan KV write budget. See [the KV quota learning](learnings/kv-free-tier-write-quota.md).

KV does not provide the atomic read-modify-write behavior needed by admin edits. A per-token `TokenWriter` Durable Object serializes create, patch, and delete operations and keeps the latest merge base in its own storage. KV remains the read store used by request authorization. A deletion marker prevents stale KV data from reviving a removed token; creating the same token again clears that marker.

KV changes can take 60 seconds or more to appear in another Cloudflare location. If access must end globally without that delay, rotate the provider credential.

## Protocol-specific behavior

### CORS and Gemini uploads

`OPTIONS` is answered before authorization because browser preflight does not include the later request's credential headers. The actual request still follows normal authorization and credential replacement.

Gemini's upload-start response contains an absolute, self-authenticating continuation URL. It is returned unchanged, allowing the client to upload directly to Google without the Worker's body-size limit. See [the CORS and upload learning](learnings/cors-preflight-and-upload-passthrough.md).

### WebSockets

WebSockets share the HTTP authorization path, then connect upstream through `fetch()` with an upgrade request and bridge both sockets. Supported token slots are Bearer, Anthropic's `x-api-key`, Gemini's `?key=`, and OpenAI's browser subprotocol entry.

Authorization and rate limiting happen once during the upgrade. Open frames are not revalidated after revocation. The fetched-socket design and close coordination are explained in [the WebSocket learning](learnings/websocket-proxy-auth-slots.md).

### OpenAI geo-block fallback

OpenAI requests use the direct edge first. Only an `unsupported_country_region_territory` 403 is retried through a US-jurisdiction Durable Object. The same fallback handles HTTP and WebSocket upgrades. It keeps the provider key inside Cloudflare and avoids charging every request for a Durable Object hop. Evidence and rejected alternatives are in [the geo-block learning](learnings/openai-egress-geo-block.md).

## Admin dashboard

The server-rendered Hono app lives under `/admin`. The browser submits the admin password, but never receives the `ADMIN_SECRET` binding. Login compares the password in constant time, applies a separate per-IP rate-limit threshold, and issues a signed, server-expired cookie. HTMX is loaded at a pinned version with a matching SRI hash.

The dashboard creates, lists, edits, disables, and deletes tokens. Generated or custom plaintext appears only in the creation response. Datetimes are entered and displayed in local time but stored as UTC ISO strings. A blank expiry means no expiry.

Admin mutations use `TokenWriter`; token creation is therefore a Durable Object operation too. Listing and request authorization read KV. The UI shows mutation results immediately rather than waiting for cross-location KV propagation.

## Security boundaries

- Provider keys are sent only from the Worker or its Durable Object to the selected provider. Application log statements do not include them.
- Rejected requests and preflight do not read provider keys.
- Token hashes protect stored data from immediately becoming usable credentials; provider keys must still be rotated if exposed.
- Do not deploy on an `*.openai.azure.com` or `*.cognitiveservices.azure.com` hostname because OpenAI clients may switch to Azure authentication.

## Test coverage

Workerd unit tests cover routing, authorization, credential removal, expiry, CORS, rate limiting, upstream fallback, streaming, and WebSocket behavior. Node and Python compatibility suites run real client libraries against an ephemeral Worker and mock upstream. They verify client configuration and wire behavior without contacting a live provider.

A shared routing slot does not prove that every client configures its base URL, endpoint, transport, or stream correctly. The policy for adding compatibility cases is in [the compatibility learning](learnings/compat-is-the-auth-slot-not-the-sdk.md).
