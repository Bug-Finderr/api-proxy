// KV-backed token store. Tokens are stored by SHA-256(token); the plaintext is shown once at creation and never persisted.
import type { CoarseProvider, TokenMetadata } from "./types";

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh opaque token: ptk_ + 32 url-safe chars (24 random bytes). */
export function generateToken(): string {
  return `ptk_${base64url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

export interface CreateInput {
  label: string;
  providers: CoarseProvider[];
  token?: string; // admin-typed; otherwise generated
  expiresAt?: string; // ISO (UTC); absent = never expires
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
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  await kv.put(hash, JSON.stringify(meta));
  return { token, hash, meta };
}

// lastUsed lives in its own key so stamping it never rewrites (and never resurrects)
// the token record that the admin may be concurrently disabling.
const luKey = (hash: string) => `${hash}:lu`;

export type TokenRow = TokenMetadata & { hash: string; lastUsed?: string };

function parseMeta(raw: string | null): TokenMetadata | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenMetadata;
  } catch {
    return null;
  }
}

/** Resolve a token hash to its metadata, only if it exists and is active. */
export async function getValidatedByHash(
  kv: KVNamespace,
  hash: string,
): Promise<TokenMetadata | null> {
  const meta = parseMeta(await kv.get(hash));
  if (meta?.status !== "active") return null;
  if (meta.expiresAt) {
    const t = Date.parse(meta.expiresAt);
    if (Number.isNaN(t) || t <= Date.now()) return null; // fail-closed on bad/past
  }
  return meta;
}

/** Resolve a plaintext token to its metadata, only if it exists and is active. */
export async function getValidated(
  kv: KVNamespace,
  token: string,
): Promise<TokenMetadata | null> {
  return getValidatedByHash(kv, await sha256hex(token));
}

export async function listTokens(kv: KVNamespace): Promise<TokenRow[]> {
  // Paginate so we never silently truncate at KV's 1000-key page limit.
  const hashes: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ cursor });
    for (const k of res.keys) if (!k.name.endsWith(":lu")) hashes.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);

  const rows = await Promise.all(
    hashes.map(async (hash): Promise<TokenRow | null> => {
      const [raw, lastUsed] = await Promise.all([
        kv.get(hash),
        kv.get(luKey(hash)),
      ]);
      const meta = parseMeta(raw);
      return meta ? { hash, ...meta, lastUsed: lastUsed ?? undefined } : null;
    }),
  );
  return rows.filter((r): r is TokenRow => r !== null);
}

export async function updateToken(
  kv: KVNamespace,
  hash: string,
  patch: Partial<Pick<TokenMetadata, "label" | "providers" | "status">>,
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
    // Write only the side key; never touch the token record (avoids resurrecting a revoke).
    await kv.put(luKey(hash), now);
  } catch {
    // Release the claim so a later request retries today; rejected puts burn no quota.
    luStampedDay.delete(hash);
  }
}
