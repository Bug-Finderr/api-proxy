// *_UPSTREAM env vars are a test seam; unset in production, so the real hosts apply.
import { coarse, type Env, type Provider } from "./types";

const DEFAULTS = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
} as const;

function upstreamBase(provider: Provider, env: Env): string {
  switch (coarse(provider)) {
    case "openai":
      return env.OPENAI_UPSTREAM || DEFAULTS.openai;
    case "anthropic":
      return env.ANTHROPIC_UPSTREAM || DEFAULTS.anthropic;
    case "gemini":
      return env.GEMINI_UPSTREAM || DEFAULTS.gemini;
  }
}

export function rewriteToUpstream(
  url: URL,
  provider: Provider,
  env: Env,
): void {
  const base = new URL(upstreamBase(provider, env));
  url.protocol = base.protocol;
  url.hostname = base.hostname;
  url.port = base.port;
}
