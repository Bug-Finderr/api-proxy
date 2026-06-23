import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
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
const TOKEN = "compat-langchain-google-token";

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  baseURL = w.url;
  await seedToken(baseURL, {
    token: TOKEN,
    providers: ["gemini"],
    label: "langchain-google-genai",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

// baseUrl is the bare host; the SDK builds `${baseUrl}/v1beta/models/<model>:generateContent`
// and sends the key in the x-goog-api-key header.
const client = () =>
  new ChatGoogleGenerativeAI({
    model: "gemini-x",
    apiKey: TOKEN,
    baseUrl: baseURL,
  });

describe("@langchain/google-genai (ChatGoogleGenerativeAI) compatibility", () => {
  it("forwards invoke() with x-goog-api-key swapped and the token absent", async () => {
    const r = await client().invoke("hi");
    expect(String(r.content)).toContain("hi");
    const cap = mock.last();
    expect(cap?.path).toContain("/v1beta/models/gemini-x:generateContent");
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
