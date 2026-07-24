# Compatibility includes client behavior

## Problem

Several clients use the same wire-level credential slot, but still differ in base-URL joining, default endpoints, generated headers, transport, and streaming.

## Decision

Give each maintained library one end-to-end case in one language. Add a case when another library has distinct configuration or transport behavior, and remove one only when that client is no longer supported or its package is replaced. Do not duplicate every language binding of the same SDK family.

A client outside the suite may be described as compatible by routing construction when it supports a base-URL override and uses a proven credential slot. It is not tested compatible until its real configuration runs through the harness.

## Known caveats

- Anthropic `authToken` mode sends Bearer and routes to OpenAI here; use its API-key mode.
- Legacy `google-generativeai` defaults to gRPC; use `transport="rest"` for this HTTP proxy.
- OpenAI-style clients may choose different default endpoints and usually expect `/v1` in the base URL. The official Anthropic SDK appends `/v1/messages` itself.

Current cases and their setup are the files in `test/sdk-compat/`, which stays more accurate than a copied client list.
