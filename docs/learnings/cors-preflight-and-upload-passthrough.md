# CORS preflight and upload passthrough

## Problem

Browser callers broke two ways: every cross-origin SDK call died before reaching the proxy, and Gemini file uploads would hit the Worker's 100 MB body cap. Both fixes are about what the proxy must *not* do. Full CORS behavior: architecture §8.

## What we found

- A preflight omits credential headers but keeps the request URL, including Gemini's `?key=`. Auth-first would reject header-auth clients and waste work for query-auth, so every `OPTIONS` request is short-circuited.
- Gemini's upload-start call returns an **absolute, self-authenticating** `x-goog-upload-url`. Rewriting it to keep the proxy in the loop would cap uploads at 100 MB, for a leg that needs no key anyway (flow diagram: architecture §8).

## The decision we keep

- Answer `OPTIONS` with `204` before token work. The later authenticated cross-origin request does carry the real key from the Worker to the provider. CORS changes browser-visible response headers, not the outbound auth swap.
- Never rewrite the upload URL. The proxy exposes the `x-goog-upload-*` response headers so the browser can continue directly with Google.
