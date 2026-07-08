# CORS preflight and upload passthrough

## Problem

Browser callers broke two ways: every cross-origin SDK call died before reaching the proxy, and Gemini file uploads would hit the Worker's 100 MB body cap. Both fixes are about what the proxy must *not* do. Full CORS behavior: architecture §8.

## What we found

- A browser sends an `OPTIONS` preflight first, and it carries **no auth header**. Auth-first (the natural instinct) 401s every preflight, so the browser never sends the real request - browser SDKs break silently.
- Gemini's upload-start call returns an **absolute, self-authenticating** `x-goog-upload-url`. Rewriting it to keep the proxy in the loop would cap uploads at 100 MB, for a leg that needs no key anyway (flow diagram: architecture §8).

## The decision we keep

- Answer `OPTIONS` with `204` **before** any token work; the real key never rides a CORS path.
- Never rewrite the upload URL - `rewriteToUpstream` touches only the request URL's protocol/host/port; the proxy just exposes the `x-goog-upload-*` headers so a browser can read them. This round trip is also why a path prefix would break Gemini ([provider-routing-by-auth-header.md](provider-routing-by-auth-header.md)).
