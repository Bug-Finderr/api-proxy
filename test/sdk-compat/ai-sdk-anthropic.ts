import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
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
const TOKEN = "compat-ai-sdk-anthropic-token";

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  baseURL = w.url;
  await seedToken(baseURL, {
    token: TOKEN,
    providers: ["anthropic"],
    label: "ai-sdk-anthropic",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

// @ai-sdk/anthropic appends only `/messages`, so baseURL must include /v1.
const model = () =>
  createAnthropic({ baseURL: `${baseURL}/v1`, apiKey: TOKEN })("claude-x");

describe("@ai-sdk/anthropic (Vercel AI SDK) compatibility", () => {
  it("forwards generateText with x-api-key swapped to the real key and the token absent", async () => {
    const r = await generateText({
      model: model(),
      prompt: "hi",
      maxOutputTokens: 16,
    });
    expect(r.text).toContain("hi");
    const cap = mock.last();
    expect(cap?.path).toBe("/v1/messages");
    expect(cap?.headers["x-api-key"]).toBe(FAKE.anthropic);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
