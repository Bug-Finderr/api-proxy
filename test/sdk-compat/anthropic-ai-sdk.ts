import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-anthropic-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["anthropic"],
  label: "anthropic",
});

// Anthropic SDK appends /v1/messages itself, so baseURL must NOT include /v1.
const client = () => new Anthropic({ baseURL: h.url(), apiKey: TOKEN });

describe("anthropic SDK compatibility", () => {
  it("forwards a message with x-api-key swapped to the real key and the token absent", async () => {
    const r = await client().messages.create({
      model: "claude-x",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).toBeTruthy();
    const cap = h.last();
    expect(cap?.path).toBe("/v1/messages");
    expect(cap?.headers["x-api-key"]).toBe(FAKE.anthropic);
    expect(cap?.headers["anthropic-version"]).toBeTruthy();
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });

  it("streams a message through the proxy", async () => {
    const stream = client().messages.stream({
      model: "claude-x",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    let text = "";
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta")
        text += ev.delta.text;
    }
    expect(text).toContain("hi");
    expect(h.last()?.headers["x-api-key"]).toBe(FAKE.anthropic);
  });
});
