import { ChatAnthropic } from "@langchain/anthropic";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-langchain-anthropic-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["anthropic"],
});

// anthropicApiUrl is the bare host; the @anthropic-ai/sdk underneath appends /v1/messages.
const client = () =>
  new ChatAnthropic({
    model: "claude-x",
    apiKey: TOKEN,
    anthropicApiUrl: h.url(),
    maxTokens: 16,
    maxRetries: 0,
  });

describe("@langchain/anthropic (ChatAnthropic) compatibility", () => {
  it("forwards invoke() with x-api-key swapped to the real key and the token absent", async () => {
    const r = await client().invoke("hi");
    expect(String(r.content)).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toBe("/v1/messages");
    expect(cap?.headers["x-api-key"]).toBe(FAKE.anthropic);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
