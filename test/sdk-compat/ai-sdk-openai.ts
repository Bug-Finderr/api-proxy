import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-ai-sdk-openai-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["openai"],
  label: "ai-sdk-openai",
});

// `.chat()` forces Chat Completions; the bare factory would hit /v1/responses (AI SDK 5+ default).
const model = () =>
  createOpenAI({ baseURL: `${h.url()}/v1`, apiKey: TOKEN }).chat("gpt-x");

describe("@ai-sdk/openai (Vercel AI SDK) compatibility", () => {
  it("forwards generateText with the real key swapped in and the token absent", async () => {
    const r = await generateText({ model: model(), prompt: "hi" });
    expect(r.text).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toBe("/v1/chat/completions");
    expect(cap?.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
