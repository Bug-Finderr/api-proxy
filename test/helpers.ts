// Shared tier-1 helpers; runs inside the same workerd pool as the tests.
import { env } from "cloudflare:workers";
import { createToken, getValidatedByHash, sha256hex } from "../src/tokens";
import type { CoarseProvider } from "../src/types";

export const seed = (token: string, providers: CoarseProvider[]) =>
  createToken(env.TOKENS, { label: token, providers, token });

export const getValidated = async (kv: KVNamespace, token: string) =>
  getValidatedByHash(kv, await sha256hex(token));

export const geo403 = () =>
  new Response(
    JSON.stringify({ error: { code: "unsupported_country_region_territory" } }),
    { status: 403 },
  );

/** Swap US_EGRESS for a fake namespace whose stub records requests and returns `reply()`. */
export function fakeEgress(
  reply: () => Response = () =>
    new Response(JSON.stringify({ ok: "via-egress" }), { status: 200 }),
): { calls: Request[]; restore: () => void } {
  const real = env.US_EGRESS;
  const calls: Request[] = [];
  const stub = {
    fetch: async (r: Request) => {
      calls.push(r);
      return reply();
    },
  };
  (env as { US_EGRESS: unknown }).US_EGRESS = { getByName: () => stub };
  return {
    calls,
    restore: () => {
      (env as { US_EGRESS: typeof real }).US_EGRESS = real;
    },
  };
}

/** Install a fake RATE_LIMITER; returns the restore fn for afterEach. */
export function setLimiter(
  limit: (o: { key: string }) => Promise<{ success: boolean }>,
): () => void {
  const real = env.RATE_LIMITER;
  (env as { RATE_LIMITER: unknown }).RATE_LIMITER = { limit };
  return () => {
    (env as { RATE_LIMITER: typeof real }).RATE_LIMITER = real;
  };
}
