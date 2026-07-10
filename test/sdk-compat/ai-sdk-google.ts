import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-ai-sdk-google-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["gemini"],
});

// @ai-sdk/google appends /models/<model>:generateContent, so baseURL must include /v1beta.
const model = () =>
  createGoogleGenerativeAI({ baseURL: `${h.url()}/v1beta`, apiKey: TOKEN })(
    "gemini-2.5-flash",
  );

describe("@ai-sdk/google (Vercel AI SDK) compatibility", () => {
  it("forwards generateText with x-goog-api-key swapped and the token absent", async () => {
    const r = await generateText({ model: model(), prompt: "hi" });
    expect(r.text).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toContain(
      "/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
