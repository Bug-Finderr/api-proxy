import { createOpenAI } from "@ai-sdk/openai";
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
const TOKEN = "compat-ai-sdk-openai-token";

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  baseURL = w.url;
  await seedToken(baseURL, {
    token: TOKEN,
    providers: ["openai"],
    label: "ai-sdk-openai",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

// `.chat()` forces Chat Completions; the bare factory would hit /v1/responses (AI SDK 5+ default).
const model = () =>
  createOpenAI({ baseURL: `${baseURL}/v1`, apiKey: TOKEN }).chat("gpt-x");

describe("@ai-sdk/openai (Vercel AI SDK) compatibility", () => {
  it("forwards generateText with the real key swapped in and the token absent", async () => {
    const r = await generateText({ model: model(), prompt: "hi" });
    expect(r.text).toContain("hi");
    const cap = mock.last();
    expect(cap?.path).toBe("/v1/chat/completions");
    expect(cap?.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
