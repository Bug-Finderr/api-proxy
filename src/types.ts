export type CoarseProvider = "openai" | "anthropic" | "gemini";
export type Provider = CoarseProvider | "gemini-openai";

/** Collapse gemini-openai onto the gemini scope used by token.providers and key lookup. */
export function coarse(provider: Provider): CoarseProvider {
  return provider === "gemini-openai" ? "gemini" : provider;
}

export interface TokenMetadata {
  label: string;
  last4: string;
  providers: CoarseProvider[];
  status: "active" | "disabled";
  createdAt: string; // ISO
  expiresAt?: string; // ISO (UTC); absent = never expires
  // lastUsed is stored in a separate `<hash>:lu` key (see tokens.ts), not here.
}

export interface Env {
  TOKENS: KVNamespace;
  US_EGRESS: DurableObjectNamespace; // North-America-pinned egress relay (UsEgress in proxy.ts)
  RATE_LIMITER: RateLimit; // per-token RPM limiter (Workers Rate Limiting binding)
  LOGIN_LIMITER: RateLimit; // low-rate per-IP throttle for /admin/login (separate ruleset)
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  ADMIN_SECRET: string;
  // Optional upstream overrides (plain vars, NOT secrets); default to the real hosts.
  OPENAI_UPSTREAM?: string;
  ANTHROPIC_UPSTREAM?: string;
  GEMINI_UPSTREAM?: string;
}
