# Rate limiting is loose abuse control

## Problem

Per-token throttling should not require another storage system or use plaintext tokens as keys.

## Evidence

Cloudflare does not document Free-plan eligibility for this binding, but deployment on this Free account succeeds and the binding enforces locally. Counters are per location and eventually consistent: with a configured 2 requests per 60 seconds, a local burst allowed roughly 13 requests before denials began. That measurement shows the threshold is not a strict quota.

## Decision

Key the binding on the token hash and fail open if it errors. Revocation and provider scope remain the real access controls. `Retry-After` is a static 60 seconds because the binding supplies no reset time.

The threshold is fixed per binding at deployment. Different per-token tiers would need separate bindings or a different counter design.

Source: [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
