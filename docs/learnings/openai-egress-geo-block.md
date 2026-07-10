# OpenAI egress geo-block

## Problem

Historical probes through the Worker saw OpenAI return `unsupported_country_region_territory` on roughly 40% of requests while Anthropic succeeded. The original run did not record its total request count, timing, or latency distribution, so 40% is a directional observation, not a reproducible rate.

## What we found

Observed HKG egresses returned the geo-403 and observed SIN egresses returned 200. The notes did not retain per-colo sample counts, so they establish the failure mode but not its prevalence. A separate probe sent **6 sequential subrequests in one Worker invocation**; all six used the same egress colo. Retrying inside that invocation therefore did not escape the affected colo.

Rejected alternatives:

- [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/) changes execution placement, not a guaranteed egress jurisdiction.
- A best-effort Durable Object `locationHint` is weaker than a jurisdiction constraint.
- [Dedicated CDN egress IPs](https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/) and [Regional Services](https://developers.cloudflare.com/data-localization/regional-services/) are Enterprise products, outside this Free deployment.
- A third-party relay adds another operator that receives the provider credential.

## The decision we keep

Try the direct edge request first. Only an OpenAI geo-403 is replayed through one of eight Durable Objects selected from `env.US_EGRESS.jurisdiction("us")`. The jurisdiction restricts the object to the US; the provider key stays out of clients, KV, and third-party relays, application log statements do not include it, and the Worker/DO necessarily sends it to OpenAI.

The post-fix stress run produced **25/25 HTTP 200 responses** across observed DO egress colos DFW, LAX, DEN, SJC, and SEA. Streaming also completed, but its probe count was not recorded. This verifies that run, not a latency or availability guarantee.

## Quantified tradeoff

For a comparison at exactly **1,000 requests** and an assumed **40%** geo-block rate:

| Design | OpenAI attempts | DO requests | DO/upstream legs |
|---|---:|---:|---:|
| Current edge-first fallback | 1,400 (1,000 initial + 400 replay) | 400 | 1,800 |
| Always route through DO | 1,000 | 1,000 | 2,000 |

Both designs also receive the same 1,000 incoming Worker requests, omitted from the table. Always-DO would issue **150% more DO requests** (`400 -> 1,000`) and **11.1% more counted DO/upstream legs** (`1,800 -> 2,000`), while eliminating 400 failed OpenAI attempts. Against Cloudflare's current Free allowance of **100,000 DO requests/day**, those scenario DO counts are **0.4%** and **1.0%**, respectively. These are scenario arithmetic, not production measurements.

No latency samples were retained, so neither the extra delay on a fallback nor the saved delay on direct successes has an honest numeric estimate. OpenAI states that unsuccessful requests can count toward per-minute limits, but its guidance does not establish whether this pre-service geo-403 consumes RPM; that remains unmeasured. Durable Object active-duration consumption is also unmeasured.

Cloudflare also lists **13,000 GB-s/day** of Free DO duration (pricing page updated 2026-06-19), but no duration samples were retained, so the scenario's share cannot be computed.

Sources: [Cloudflare Durable Object data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [OpenAI rate-limit guidance](https://help.openai.com/en/articles/5955604-how-can-i-solv).
