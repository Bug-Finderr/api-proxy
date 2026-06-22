export type CoarseProvider = "openai" | "anthropic" | "gemini";
export type Provider = CoarseProvider | "gemini-openai";

export interface TokenMetadata {
	label: string;
	last4: string;
	providers: CoarseProvider[];
	status: "active" | "disabled";
	createdAt: string; // ISO
	lastUsed?: string; // ISO
	// reserved for Later (absent in v1): expiresAt, limits, spend
}

export interface Env {
	TOKENS: KVNamespace;
	OPENAI_API_KEY: string;
	ANTHROPIC_API_KEY: string;
	GEMINI_API_KEY: string;
	ADMIN_SECRET: string;
	// Optional upstream overrides (plain vars, NOT secrets); default to the real hosts.
	OPENAI_UPSTREAM?: string;
	ANTHROPIC_UPSTREAM?: string;
	GEMINI_UPSTREAM?: string;
}
