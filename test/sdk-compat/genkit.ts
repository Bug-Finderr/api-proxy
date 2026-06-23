import { googleAI } from "@genkit-ai/google-genai";
import { genkit } from "genkit";
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
const TOKEN = "compat-genkit-token";

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  baseURL = w.url;
  await seedToken(baseURL, {
    token: TOKEN,
    providers: ["gemini"],
    label: "genkit",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

// googleAI({ baseUrl }) is the bare host; the plugin builds `${baseUrl}/v1beta/models/<model>:...`
// and sends the key in the x-goog-api-key header.
const ai = () =>
  genkit({ plugins: [googleAI({ apiKey: TOKEN, baseUrl: baseURL })] });

describe("genkit (@genkit-ai/google-genai) compatibility", () => {
  it("forwards ai.generate with x-goog-api-key swapped and the token absent", async () => {
    const r = await ai().generate({
      model: googleAI.model("gemini-2.5-flash"),
      prompt: "hi",
    });
    expect(r.text).toContain("hi");
    const cap = mock.last();
    expect(cap?.path).toContain(
      "/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
