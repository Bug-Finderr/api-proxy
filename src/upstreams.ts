// Upstream resolver + test seam. *_UPSTREAM env vars default to the real hosts, so
// production is unchanged when unset; tests point them at a local mock.
import type { Provider, Env } from "./types";

const DEFAULTS = {
	openai: "https://api.openai.com",
	anthropic: "https://api.anthropic.com",
	gemini: "https://generativelanguage.googleapis.com",
} as const;

export function upstreamBase(provider: Provider, env: Env): string {
	switch (provider === "gemini-openai" ? "gemini" : provider) {
		case "openai":
			return env.OPENAI_UPSTREAM || DEFAULTS.openai;
		case "anthropic":
			return env.ANTHROPIC_UPSTREAM || DEFAULTS.anthropic;
		case "gemini":
			return env.GEMINI_UPSTREAM || DEFAULTS.gemini;
	}
}

/** Rewrite protocol/hostname/port to the upstream, leaving path and query intact. */
export function rewriteToUpstream(url: URL, provider: Provider, env: Env): void {
	const base = new URL(upstreamBase(provider, env));
	url.protocol = base.protocol;
	url.hostname = base.hostname;
	url.port = base.port;
}
