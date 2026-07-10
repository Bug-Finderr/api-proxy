# Provider routing by auth slot

## Problem

One consolidated base URL has to transparently serve OpenAI, Anthropic, and Gemini. The goal: a client changes only its base URL and API key, nothing else. So the proxy must decide which upstream a request is for without the client adding a path prefix or custom header.

## What we found

Each SDK already announces its provider by *which auth slot it populates* - no path prefix or custom header needed. The slot-to-provider mapping lives in architecture §4; the check order matters and is (`src/auth.ts` `identify`):

```mermaid
flowchart TD
    R[inbound request] --> A{"x-api-key?"}
    A -- yes --> ANT[Anthropic]
    A -- no --> B{"x-goog-api-key?"}
    B -- yes --> GEM[Gemini]
    B -- no --> C{"Authorization: Bearer?"}
    C -- no --> D{"?key= query param?"}
    D -- yes --> GEM
    D -- no --> E[401]
    C -- yes --> P{"path starts /v1beta/openai/?"}
    P -- yes --> GO["Gemini (OpenAI-compat)"]
    P -- no --> OAI[OpenAI]
```

**Why not a path prefix:** the auth slot already identifies the provider. A prefix would add provider-specific stripping branches and alter the native paths clients expect without adding routing information.

## The decision we keep

Route by auth slot, keeping each SDK's native path intact - a true drop-in. The token is extracted from the same slot; the swap is [proxy-token-security.md](proxy-token-security.md)'s territory.
