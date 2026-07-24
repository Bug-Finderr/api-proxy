# OpenAI egress geo-block

## Problem

Historical probes sometimes received OpenAI's `unsupported_country_region_territory` response through the Worker while Anthropic succeeded. The original notes estimated a 40% failure rate but did not retain the sample count, timing, or latency, so that number is directional only.

## Evidence

Observed HKG egress returned the geo-403 and observed SIN egress returned 200. Six sequential subrequests in one Worker invocation used the same egress location, so retrying inside that invocation did not escape the block.

A post-fix run returned 25/25 HTTP 200 responses through US-jurisdiction Durable Objects across observed DFW, LAX, DEN, SJC, and SEA egress. This verifies that run, not a general availability or latency guarantee.

## Rejected alternatives

- Smart Placement changes execution placement but does not guarantee egress jurisdiction.
- A Durable Object location hint is weaker than a jurisdiction constraint.
- Dedicated egress IPs and Regional Services are outside this Free deployment.
- A third-party relay would receive the provider credential.
- Routing every request through a Durable Object adds a hop and a Durable Object request even when direct egress works.

## Decision

Try direct edge egress first. Retry only OpenAI's geo-specific 403 through `env.US_EGRESS.jurisdiction("us")`. This keeps provider credentials inside Cloudflare while limiting fallback cost to affected requests.

Sources: [Cloudflare Durable Object data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
