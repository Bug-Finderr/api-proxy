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

export function fakeEgress(
  reply: () => Response = () =>
    new Response(JSON.stringify({ ok: "via-egress" }), { status: 200 }),
): {
  calls: Request[];
  jurisdictions: string[];
  names: string[];
  restore: () => void;
} {
  const real = env.US_EGRESS;
  const calls: Request[] = [];
  const jurisdictions: string[] = [];
  const names: string[] = [];
  const stub = {
    fetch: async (r: Request) => {
      calls.push(r);
      return reply();
    },
  };
  const getByName = (name: string) => {
    names.push(name);
    return stub;
  };
  (env as { US_EGRESS: unknown }).US_EGRESS = {
    getByName,
    jurisdiction: (jurisdiction: string) => {
      jurisdictions.push(jurisdiction);
      return { getByName };
    },
  };
  return {
    calls,
    jurisdictions,
    names,
    restore: () => {
      (env as { US_EGRESS: typeof real }).US_EGRESS = real;
    },
  };
}

export function setLimiter(
  limit: (o: { key: string }) => Promise<{ success: boolean }>,
): () => void {
  const real = env.RATE_LIMITER;
  (env as { RATE_LIMITER: unknown }).RATE_LIMITER = { limit };
  return () => {
    (env as { RATE_LIMITER: typeof real }).RATE_LIMITER = real;
  };
}
