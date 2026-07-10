import { afterAll, beforeAll, beforeEach } from "vitest";
import {
  type Captured,
  FAKE,
  type MockUpstream,
  seedToken,
  startMockUpstream,
  startWorker,
  type TestWorker,
} from "./mock.mts";

export { FAKE };

/** Accessors are lazy: call url()/last() inside it(), not at module scope. */
export function compatHarness(opts: { token: string; providers: string[] }): {
  url(): string;
  last(): Captured | null;
} {
  let mock: MockUpstream;
  let worker: TestWorker;
  let url = "";
  beforeAll(async () => {
    mock = await startMockUpstream();
    const w = await startWorker(mock.url);
    worker = w.worker;
    url = w.url;
    await seedToken(url, opts);
  });
  afterAll(async () => {
    try {
      await worker?.dispose();
    } finally {
      await mock?.close();
    }
  });
  beforeEach(() => mock.reset());
  return { url: () => url, last: () => mock.last() };
}
