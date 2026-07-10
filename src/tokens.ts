// Tokens are keyed by SHA-256(token); the plaintext is never persisted.
import type { CoarseProvider, TokenMetadata } from "./types";

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return new Uint8Array(digest).toHex();
}

export function generateToken(): string {
  return `ptk_${crypto.getRandomValues(new Uint8Array(24)).toBase64({ alphabet: "base64url", omitPadding: true })}`;
}

export interface CreateInput {
  label: string;
  providers: CoarseProvider[];
  token?: string;
  expiresAt?: string;
}

export async function createToken(
  kv: KVNamespace,
  input: CreateInput,
): Promise<{ token: string; hash: string; meta: TokenMetadata }> {
  const token = input.token || generateToken();
  const hash = await sha256hex(token);
  const meta: TokenMetadata = {
    label: input.label,
    last4: token.slice(-4),
    providers: input.providers,
    status: "active",
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  };
  await kv.put(hash, JSON.stringify(meta));
  return { token, hash, meta };
}

// Own key so stamping never rewrites (or resurrects) a record the admin is concurrently disabling.
const luKey = (hash: string) => `${hash}:lu`;

export type TokenRow = TokenMetadata & { hash: string; lastUsed?: string };

const parseMeta = (raw: string | null): TokenMetadata | null =>
  raw ? (JSON.parse(raw) as TokenMetadata) : null;

export async function getValidatedByHash(
  kv: KVNamespace,
  hash: string,
): Promise<TokenMetadata | "expired" | null> {
  const meta = parseMeta(await kv.get(hash));
  if (meta?.status !== "active") return null;
  if (meta.expiresAt) {
    const t = Date.parse(meta.expiresAt);
    if (Number.isNaN(t)) return null; // fail-closed on malformed
    if (t <= Date.now()) return "expired";
  }
  return meta;
}

export async function listTokens(kv: KVNamespace): Promise<TokenRow[]> {
  const { keys } = await kv.list();
  const hashes = keys.map((k) => k.name).filter((n) => !n.endsWith(":lu"));
  if (!hashes.length) return [];
  // Bulk get caps at 100 keys = 50 tokens, consistent with the single-page list() above.
  const vals = await kv.get(hashes.flatMap((h) => [h, luKey(h)]));
  return hashes.flatMap((hash) => {
    const meta = parseMeta(vals.get(hash) ?? null);
    return meta
      ? [{ hash, ...meta, lastUsed: vals.get(luKey(hash)) ?? undefined }]
      : [];
  });
}

export async function updateToken(
  kv: KVNamespace,
  hash: string,
  patch: Pick<TokenMetadata, "status">,
): Promise<TokenMetadata | null> {
  const meta = parseMeta(await kv.get(hash));
  if (!meta) return null;
  const updated = { ...meta, ...patch };
  await kv.put(hash, JSON.stringify(updated));
  return updated;
}

export async function deleteToken(
  kv: KVNamespace,
  hash: string,
): Promise<void> {
  await Promise.all([kv.delete(hash), kv.delete(luKey(hash))]);
}

// One stamp per UTC day per isolate: the dashboard shows only the date, and the free tier allows 1,000 KV writes/day account-wide.
const luStampedDay = new Map<string, string>();

export async function touchLastUsed(
  kv: KVNamespace,
  hash: string,
): Promise<void> {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  if (luStampedDay.get(hash) === day) return;
  luStampedDay.set(hash, day); // claim before the await so concurrent requests dedupe
  try {
    await kv.put(luKey(hash), now);
  } catch (err) {
    // Release the claim so a later request retries today; rejected puts burn no quota.
    luStampedDay.delete(hash);
    console.warn("lastUsed stamp failed", err);
  }
}
