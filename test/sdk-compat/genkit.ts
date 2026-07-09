import { googleAI } from "@genkit-ai/google-genai";
import { genkit } from "genkit";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-genkit-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["gemini"],
  label: "genkit",
});

// googleAI({ baseUrl }) is the bare host; the plugin builds `${baseUrl}/v1beta/models/<model>:...`
// and sends the key in the x-goog-api-key header.
const ai = () =>
  genkit({ plugins: [googleAI({ apiKey: TOKEN, baseUrl: h.url() })] });

describe("genkit (@genkit-ai/google-genai) compatibility", () => {
  it("forwards ai.generate with x-goog-api-key swapped and the token absent", async () => {
    const r = await ai().generate({
      model: googleAI.model("gemini-2.5-flash"),
      prompt: "hi",
    });
    expect(r.text).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toContain(
      "/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
