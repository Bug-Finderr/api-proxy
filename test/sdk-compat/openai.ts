import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-openai-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["openai"],
});

const client = () => new OpenAI({ baseURL: `${h.url()}/v1`, apiKey: TOKEN });

describe("openai SDK compatibility", () => {
  it("forwards a chat completion with the real key swapped in and the token absent", async () => {
    const r = await client().chat.completions.create({
      model: "gpt-x",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).toBeTruthy();
    const cap = h.last();
    expect(cap?.path).toBe("/v1/chat/completions");
    expect(cap?.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });

  it("streams a chat completion through the proxy", async () => {
    const stream = await client().chat.completions.create({
      model: "gpt-x",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    let text = "";
    for await (const chunk of stream)
      text += chunk.choices?.[0]?.delta?.content ?? "";
    expect(text).toContain("hi");
    expect(h.last()?.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
  });
});
