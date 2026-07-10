# Compatibility is routing plus client behavior

## Problem

Many clients share the same wire-level authentication, but that does not make their integrations interchangeable. A proxy can route a correct header and still break a client through base-URL joining, a default endpoint, generated headers, transport selection, or streaming behavior.

## What we found

Routing has a small invariant: the auth slot and one path check select the provider, while the remaining path, query, body, and response stream pass through.

| Route | Routing signal |
|---|---|
| OpenAI | `Authorization: Bearer` |
| Anthropic | `x-api-key` |
| Gemini native | `x-goog-api-key` or `?key=` |
| Gemini OpenAI-compatible | `Authorization: Bearer` plus `/v1beta/openai/` |

That invariant proves a new client needs no new proxy branch. It does **not** prove the client is configured correctly. The maintained compatibility cases exercise:

- official OpenAI, Anthropic, and Google GenAI SDKs;
- Vercel AI SDK and LangChain adapters for all three providers;
- Genkit's Google adapter;
- LiteLLM, LlamaIndex, instructor, and Pydantic AI;
- raw HTTP and a real WebSocket round trip.

Together they verify the clients' actual base-URL options, endpoint defaults, implicit headers, request/response formats, and streaming parsers. They also expose conflicts such as a wrapper changing auth mode or a transport bypassing HTTP.

## The decision we keep

Keep every current compatibility client. Each distinct library gets one end-to-end case in one language, both as regression coverage and executable setup documentation. Sharing an auth slot is not a reason to delete its case. Repeating every language binding of the same SDK family usually is.

Add a case when support is claimed for another library with distinct configuration or transport behavior. Remove one only when that client is no longer supported or its package is replaced, not merely because another test reaches the same route.

Clients outside the suite can be described as **compatible by routing construction**, not tested compatible, when they expose a base-URL override and use a proven slot. This includes other language bindings and OpenAI-compatible end-user applications.

## Caveats

- Anthropic `authToken` mode sends Bearer and therefore routes to OpenAI here; use API-key (`x-api-key`) mode.
- Legacy `google-generativeai` for Python defaults to gRPC; use `transport="rest"` so it traverses this HTTP proxy.
- OpenAI clients may default to `/v1/responses` instead of `/v1/chat/completions`. Both route by Bearer, but the separate client tests still catch endpoint expectations.
- Base-URL conventions differ: OpenAI-style clients generally include `/v1`; the official Anthropic SDK appends `/v1/messages` itself.
