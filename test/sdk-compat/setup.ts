import { afterAll, beforeAll, beforeEach } from "vitest";
import { type Unstable_DevWorker, unstable_dev } from "wrangler";
import {
  ADMIN_SECRET,
  type Captured,
  FAKE,
  type MockUpstream,
  seedToken,
  startMockUpstream,
} from "./mock.mjs";

export type { Captured, MockUpstream };
export { ADMIN_SECRET, FAKE, seedToken, startMockUpstream };

export async function startWorker(
  mockUrl: string,
): Promise<{ worker: Unstable_DevWorker; url: string }> {
  const worker = await unstable_dev("src/index.ts", {
    config: "wrangler.toml",
    local: true,
    vars: {
      OPENAI_API_KEY: FAKE.openai,
      ANTHROPIC_API_KEY: FAKE.anthropic,
      GEMINI_API_KEY: FAKE.gemini,
      ADMIN_SECRET,
      OPENAI_UPSTREAM: mockUrl,
      ANTHROPIC_UPSTREAM: mockUrl,
      GEMINI_UPSTREAM: mockUrl,
    },
    experimental: { disableExperimentalWarning: true },
  });
  return { worker, url: `http://${worker.address}:${worker.port}` };
}

/** Per-file harness: boots the mock + worker + seeded token in beforeAll, tears down in
 *  afterAll, resets the capture in beforeEach. Accessors are lazy so call them inside it(). */
export function compatHarness(opts: {
  token: string;
  providers: string[];
  label?: string;
}): { url(): string; last(): Captured | null } {
  let mock: MockUpstream;
  let worker: Unstable_DevWorker;
  let url = "";
  beforeAll(async () => {
    mock = await startMockUpstream();
    const w = await startWorker(mock.url);
    worker = w.worker;
    url = w.url;
    await seedToken(url, opts);
  });
  afterAll(async () => {
    await worker?.stop();
    await mock?.close();
  });
  beforeEach(() => mock.reset());
  return { url: () => url, last: () => mock.last() };
}
