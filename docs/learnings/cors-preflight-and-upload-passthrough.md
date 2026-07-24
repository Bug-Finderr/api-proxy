# CORS preflight and upload passthrough

## Problem

Browser preflight does not carry the credential headers used by the actual request. Gemini uploads also return a continuation URL for a body that may exceed the Worker's limit.

## Decision

- Answer `OPTIONS` with 204 before token validation. The later request still runs normal authorization and credential replacement.
- Return Gemini's absolute, self-authenticating `x-goog-upload-url` unchanged and expose the related response headers. The client then uploads directly to Google.

Keeping the second upload leg outside the proxy avoids rejecting preflight and avoids routing large, already-authorized upload bodies through the Worker.
