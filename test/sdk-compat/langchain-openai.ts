import { ChatOpenAI } from "@langchain/openai";
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
const TOKEN = "compat-langchain-openai-token";

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  baseURL = w.url;
  await seedToken(baseURL, {
    token: TOKEN,
    providers: ["openai"],
    label: "langchain-openai",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

// `configuration` is passed straight to the underlying `openai` SDK; a plain model name
// (not gpt-5.x-pro) with no tools stays on /v1/chat/completions, not /v1/responses.
const client = () =>
  new ChatOpenAI({
    model: "gpt-x",
    apiKey: TOKEN,
    configuration: { baseURL: `${baseURL}/v1` },
    maxRetries: 0,
  });

describe("@langchain/openai (ChatOpenAI) compatibility", () => {
  it("forwards invoke() with the real key swapped in and the token absent", async () => {
    const r = await client().invoke("hi");
    expect(String(r.content)).toContain("hi");
    const cap = mock.last();
    expect(cap?.path).toBe("/v1/chat/completions");
    expect(cap?.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
