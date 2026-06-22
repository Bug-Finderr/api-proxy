import Anthropic from "@anthropic-ai/sdk";
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
const TOKEN = "compat-anthropic-token";

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  baseURL = w.url;
  await seedToken(baseURL, {
    token: TOKEN,
    providers: ["anthropic"],
    label: "anthropic",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

// Anthropic SDK appends /v1/messages itself, so baseURL must NOT include /v1.
const client = () => new Anthropic({ baseURL, apiKey: TOKEN });

describe("anthropic SDK compatibility", () => {
  it("forwards a message with x-api-key swapped to the real key and the token absent", async () => {
    const r = await client().messages.create({
      model: "claude-x",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).toBeTruthy();
    const cap = mock.last();
    expect(cap?.path).toBe("/v1/messages");
    expect(cap?.headers["x-api-key"]).toBe(FAKE.anthropic);
    expect(cap?.headers["anthropic-version"]).toBeTruthy(); // SDK header passed through
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
    expect(mock.last()?.headers["x-api-key"]).toBe(FAKE.anthropic);
  });
});
