# Learnings

A running log of the decisions and discoveries that shaped this proxy. One topic per file,
kept short. Append a new file when something non-obvious changes the design; don't rewrite history.

Each file: the problem, what we found, and the decision we keep.

- [openai-egress-geo-block.md](openai-egress-geo-block.md) - why OpenAI 403'd ~40% of the time, and the North-America-pinned Durable Object that fixes it
- [provider-routing-by-auth-header.md](provider-routing-by-auth-header.md) - one base URL, no path prefix; route by which auth slot the SDK used
- [doppelganger-token-security.md](doppelganger-token-security.md) - how a shareable token rides the SDK's auth slot without ever leaking the real key
