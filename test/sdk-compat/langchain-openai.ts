import { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-langchain-openai-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["openai"],
  label: "langchain-openai",
});

// a plain model name with no tools stays on /v1/chat/completions, not /v1/responses
const client = () =>
  new ChatOpenAI({
    model: "gpt-x",
    apiKey: TOKEN,
    configuration: { baseURL: `${h.url()}/v1` },
    maxRetries: 0,
  });

describe("@langchain/openai (ChatOpenAI) compatibility", () => {
  it("forwards invoke() with the real key swapped in and the token absent", async () => {
    const r = await client().invoke("hi");
    expect(String(r.content)).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toBe("/v1/chat/completions");
    expect(cap?.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
