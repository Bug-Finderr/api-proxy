export type CoarseProvider = "openai" | "anthropic" | "gemini";
export type Provider = CoarseProvider | "gemini-openai";

export function coarse(provider: Provider): CoarseProvider {
  return provider === "gemini-openai" ? "gemini" : provider;
}

export interface TokenMetadata {
  label: string;
  last4: string;
  providers: CoarseProvider[];
  status: "active" | "disabled";
  createdAt: string;
  expiresAt?: string;
  // lastUsed is stored in a separate `<hash>:lu` key (see tokens.ts), not here.
}

export interface Env {
  TOKENS: KVNamespace;
  US_EGRESS: DurableObjectNamespace;
  TOKEN_WRITER: DurableObjectNamespace<import("./tokens").TokenWriter>;
  RATE_LIMITER: RateLimit;
  LOGIN_LIMITER: RateLimit;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  ADMIN_SECRET: string;
  OPENAI_UPSTREAM?: string;
  ANTHROPIC_UPSTREAM?: string;
  GEMINI_UPSTREAM?: string;
}
