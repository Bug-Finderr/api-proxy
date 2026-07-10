import { DurableObject } from "cloudflare:workers";
import { stripAuthSlots } from "./auth";
import { coarse, type Env, type Provider } from "./types";

// *_UPSTREAM env vars are a test seam; unset in production, so the real hosts apply.
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

export function realKeyFor(provider: Provider, env: Env): string {
  switch (coarse(provider)) {
    case "openai":
      return env.OPENAI_API_KEY;
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "gemini":
      return env.GEMINI_API_KEY;
  }
}

export function swapAuth(
  headers: Headers,
  url: URL,
  provider: Provider,
  realKey: string,
): void {
  stripAuthSlots(headers, url);
  switch (provider) {
    case "openai":
    case "gemini-openai":
      headers.set("authorization", `Bearer ${realKey}`);
      break;
    case "anthropic":
      headers.set("x-api-key", realKey);
      break;
    case "gemini":
      headers.set("x-goog-api-key", realKey);
      break;
  }
}

export async function isGeoBlock(res: Response): Promise<boolean> {
  return (
    res.status === 403 &&
    (await res.clone().text()).includes("unsupported_country_region_territory")
  );
}

// OpenAI geo-403s some colos (e.g. HKG); a Worker's egress colo is fixed per invocation,
// so a retry cannot escape it. The US-jurisdiction DO fetches from a supported region.
// The real key never leaves Cloudflare.
export class UsEgress extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}

const EGRESS_POOL = 8;

export function egressStub(env: Env): DurableObjectStub {
  return env.US_EGRESS.jurisdiction("us").getByName(
    `oa-egress-${Math.floor(Math.random() * EGRESS_POOL)}`,
  );
}
