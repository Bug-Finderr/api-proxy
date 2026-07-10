import { getValidatedByHash, sha256hex } from "./tokens";
import { coarse, type Env, type Provider, type TokenMetadata } from "./types";

/** Infer the provider from the HTTP auth slot carrying the proxy token. */
export function identify(
  req: Request,
  url: URL,
): { token: string; provider: Provider } | null {
  const h = req.headers;
  const xApiKey = h.get("x-api-key");
  if (xApiKey) return { token: xApiKey, provider: "anthropic" };
  const xGoog = h.get("x-goog-api-key");
  if (xGoog) return { token: xGoog, provider: "gemini" };
  const m = /^Bearer\s+(.+)$/i.exec(h.get("authorization") ?? "");
  if (m) {
    const provider = url.pathname.startsWith("/v1beta/openai/")
      ? "gemini-openai"
      : "openai";
    return { token: m[1].trim(), provider };
  }
  const key = url.searchParams.get("key");
  return key ? { token: key, provider: "gemini" } : null;
}

/** Remove every HTTP auth slot read by identify(). */
export function stripAuthSlots(headers: Headers, url: URL): void {
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("authorization");
  url.searchParams.delete("key");
}

export async function authorize(
  env: Env,
  token: string,
  provider: Provider,
): Promise<{ hash: string } | { status: number; message: string }> {
  const hash = await sha256hex(token);
  let meta: TokenMetadata | "expired" | null;
  try {
    meta = await getValidatedByHash(env.TOKENS, hash);
  } catch (err) {
    // KV outage / exhausted read quota: a controlled 503, not an unhandled 1101.
    console.error("token store read failed", err);
    return { status: 503, message: "token store unavailable" };
  }
  if (meta === "expired") return { status: 401, message: "token expired" };
  if (!meta) return { status: 401, message: "invalid or revoked token" };
  if (!meta.providers.includes(coarse(provider)))
    return { status: 403, message: "token not allowed for provider" };

  // Fail-open: an erroring limiter must never brick the proxy. The binding counts
  // per-colo, so it is a loose ceiling, not strict abuse prevention.
  try {
    if (!(await env.RATE_LIMITER.limit({ key: hash })).success)
      return { status: 429, message: "rate limit exceeded" };
  } catch {}
  return { hash };
}
