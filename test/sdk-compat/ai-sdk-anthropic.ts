import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-ai-sdk-anthropic-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["anthropic"],
  label: "ai-sdk-anthropic",
});

// @ai-sdk/anthropic appends only `/messages`, so baseURL must include /v1.
const model = () =>
  createAnthropic({ baseURL: `${h.url()}/v1`, apiKey: TOKEN })("claude-x");

describe("@ai-sdk/anthropic (Vercel AI SDK) compatibility", () => {
  it("forwards generateText with x-api-key swapped to the real key and the token absent", async () => {
    const r = await generateText({
      model: model(),
      prompt: "hi",
      maxOutputTokens: 16,
    });
    expect(r.text).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toBe("/v1/messages");
    expect(cap?.headers["x-api-key"]).toBe(FAKE.anthropic);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
