# OpenAI egress geo-block

## Problem

Through the Worker, OpenAI returned `403 unsupported_country_region_territory` intermittently
(~40% of requests). Anthropic was always fine. A valid key, correct path, correct auth.

## The mechanism in one picture

```
          ┌─────────── Cloudflare ───────────┐
client ──▶│ Worker runs in the colo nearest  │
          │ the client; fetch() egresses from│
          │ THAT colo (fixed per invocation) │
          └───────┬───────────────┬──────────┘
                  │               │
         egress via SIN   egress via HKG
                  │               │
                  ▼               ▼
              OpenAI 200      OpenAI 403  ← "unsupported_country_region_territory"
                              (HKG is a region OpenAI does not serve)
```

Roughly 40% of invocations happened to egress via HKG, hence the ~40% failure.

## What we found

- Single probes of `GET /v1/models`, `POST /v1/chat/completions`, and streaming all succeeded, so
  egress was not blanket-blocked.
- Hammering the same endpoint exposed the ~40% failure, and the failures correlated **100%** with
  the Cloudflare egress colo: every request that egressed via **Hong Kong (HKG) returned 403**, every
  one via **Singapore (SIN) returned 200**. It is OpenAI's country geo-restriction (HKG/CN unsupported),
  not an IP-reputation or bot block. Anthropic works because it does not geo-block those regions.
- A Worker's `fetch()` egresses from the colo the invocation runs in, and that colo varies per request.
- The egress colo is **pinned per invocation**: six sequential subrequests inside one invocation always
  hit the same colo. So an in-invocation **retry cannot escape a bad colo** - it just re-hits HKG. The
  colo only re-rolls across separate invocations.

## What does NOT fix it

- **Smart Placement** and **`placement.region`** optimize *execution* location for *latency*, not
  *egress country*. They have no notion of "OpenAI-supported region," can leave a Worker in HKG, and
  for a single-subrequest proxy may not relocate at all. Community reports confirm they don't fix this.
- **Dedicated Egress IPs / Regional Services** would pin egress region, but they are paid/Enterprise.
- A **third-party relay** in a supported region (Vercel `iad1`, free VPS) works, but routes the real
  OpenAI key through another host - rejected on the "key never leaves Cloudflare" rule.

## The fix

Route **only the OpenAI hop** through a Durable Object pinned to North America with
`locationHint:"wnam"` (`src/egress.ts`). The DO runs in a US colo, so its `fetch()` egresses from an
OpenAI-supported region. It is wired as a **fallback**, not the default path: try the fast edge fetch
first and re-issue through the DO **only on the geo-403** (`src/proxy.ts`). The request body is buffered
for OpenAI so it can be replayed to the DO.

The egress DO is **pooled across 8 named instances** (`EGRESS_POOL=8`, `idFromName('oa-egress-N')` with a
random `N`), so all OpenAI traffic isn't funneled through one DO.

```
OpenAI request
      │
      ▼
 direct edge fetch() ──── 200 ──▶ return (fast path, ~60%)
      │
   geo-403?
      │ yes
      ▼
 re-issue through US-pinned DO (locationHint:"wnam")
      │
      ▼
 DO runs in a US colo ─▶ fetch() egresses US ─▶ OpenAI 200 ─▶ return
```

Why this shape:
- The real key never leaves Cloudflare.
- Free on the Workers Free plan (SQLite-backed Durable Object).
- The ~60% of OpenAI calls that already egress from a good colo stay fast (no extra hop); Anthropic and
  Gemini are untouched.

## Result

Post-fix stress test: 25/25 `200`, 0 `403`. The DO's egress colos verified as US (DFW/LAX/DEN/SJC/SEA).
Streaming survives the fallback. If another provider ever shows the same geo-403, apply the same DO
pattern by extending the `coarse(provider) === "openai"` branch.
