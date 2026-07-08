import { ChatAnthropic } from "@langchain/anthropic";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Unstable_DevWorker } from "wrangler";
import {
  FAKE,
  type MockUpstream,
  seedToken,
  startMockUpstream,
  startWorker,
} from "./setup";

let mock: MockUpstream;
let worker: Unstable_DevWorker;
let baseURL: string;
const TOKEN = "compat-langchain-anthropic-token";

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  baseURL = w.url;
  await seedToken(baseURL, {
    token: TOKEN,
    providers: ["anthropic"],
    label: "langchain-anthropic",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

// anthropicApiUrl is the bare host; the @anthropic-ai/sdk underneath appends /v1/messages.
const client = () =>
  new ChatAnthropic({
    model: "claude-x",
    apiKey: TOKEN,
    anthropicApiUrl: baseURL,
    maxTokens: 16,
    maxRetries: 0,
  });

describe("@langchain/anthropic (ChatAnthropic) compatibility", () => {
  it("forwards invoke() with x-api-key swapped to the real key and the token absent", async () => {
    const r = await client().invoke("hi");
    expect(String(r.content)).toContain("hi");
    const cap = mock.last();
    expect(cap?.path).toBe("/v1/messages");
    expect(cap?.headers["x-api-key"]).toBe(FAKE.anthropic);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
