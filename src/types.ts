export type CoarseProvider = "openai" | "anthropic" | "gemini";
export type Provider = CoarseProvider | "gemini-openai";

export interface TokenMetadata {
  label: string;
  last4: string;
  providers: CoarseProvider[];
  status: "active" | "disabled";
  createdAt: string; // ISO
  expiresAt?: string; // ISO (UTC); absent = never expires
  // lastUsed is stored in a separate `<hash>:lu` key (see tokens.ts), not here.
  // reserved for Later: limits, spend
}

export interface Env {
  TOKENS: KVNamespace;
  US_EGRESS: DurableObjectNamespace; // North-America-pinned egress relay (see egress.ts)
  RATE_LIMITER: RateLimit; // per-token RPM limiter (Workers Rate Limiting binding)
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  ADMIN_SECRET: string;
  // Optional upstream overrides (plain vars, NOT secrets); default to the real hosts.
  OPENAI_UPSTREAM?: string;
  ANTHROPIC_UPSTREAM?: string;
  GEMINI_UPSTREAM?: string;
}
