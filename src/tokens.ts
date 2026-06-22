// KV-backed token store. Tokens are stored by SHA-256(token); the plaintext is shown
// once at creation and never persisted.
import type { TokenMetadata, CoarseProvider } from "./types";

export async function sha256hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh opaque token: dgk_ + 32 url-safe chars (24 random bytes). */
export function generateToken(): string {
	return "dgk_" + base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export interface CreateInput {
	label: string;
	providers: CoarseProvider[];
	token?: string; // admin-typed; otherwise generated
}

export async function createToken(
	kv: KVNamespace,
	input: CreateInput,
): Promise<{ token: string; hash: string; meta: TokenMetadata }> {
	const token = input.token?.trim() || generateToken();
	const hash = await sha256hex(token);
	const meta: TokenMetadata = {
		label: input.label,
		last4: token.slice(-4),
		providers: input.providers,
		status: "active",
		createdAt: new Date().toISOString(),
	};
	await kv.put(hash, JSON.stringify(meta));
	return { token, hash, meta };
}

/** Resolve a token hash to its metadata, only if it exists and is active. */
export async function getValidatedByHash(kv: KVNamespace, hash: string): Promise<TokenMetadata | null> {
	const raw = await kv.get(hash);
	if (!raw) return null;
	const meta = JSON.parse(raw) as TokenMetadata;
	return meta.status === "active" ? meta : null;
}

/** Resolve a plaintext token to its metadata, only if it exists and is active. */
export async function getValidated(kv: KVNamespace, token: string): Promise<TokenMetadata | null> {
	return getValidatedByHash(kv, await sha256hex(token));
}

export async function listTokens(kv: KVNamespace): Promise<(TokenMetadata & { hash: string })[]> {
	const { keys } = await kv.list();
	const rows: (TokenMetadata & { hash: string })[] = [];
	for (const k of keys) {
		const raw = await kv.get(k.name);
		if (raw) rows.push({ hash: k.name, ...(JSON.parse(raw) as TokenMetadata) });
	}
	return rows;
}

export async function updateToken(
	kv: KVNamespace,
	hash: string,
	patch: Partial<Pick<TokenMetadata, "label" | "providers" | "status">>,
): Promise<TokenMetadata | null> {
	const raw = await kv.get(hash);
	if (!raw) return null;
	const meta = { ...(JSON.parse(raw) as TokenMetadata), ...patch };
	await kv.put(hash, JSON.stringify(meta));
	return meta;
}

export async function deleteToken(kv: KVNamespace, hash: string): Promise<void> {
	await kv.delete(hash);
}

export async function touchLastUsed(kv: KVNamespace, hash: string): Promise<void> {
	const raw = await kv.get(hash);
	if (!raw) return;
	const meta = JSON.parse(raw) as TokenMetadata;
	meta.lastUsed = new Date().toISOString();
	await kv.put(hash, JSON.stringify(meta));
}
