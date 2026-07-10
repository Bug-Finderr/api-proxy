import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-langchain-google-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["gemini"],
});

// baseUrl is the bare host; the SDK appends /v1beta/models/<model>:generateContent
const client = () =>
  new ChatGoogleGenerativeAI({
    model: "gemini-x",
    apiKey: TOKEN,
    baseUrl: h.url(),
  });

describe("@langchain/google-genai (ChatGoogleGenerativeAI) compatibility", () => {
  it("forwards invoke() with x-goog-api-key swapped and the token absent", async () => {
    const r = await client().invoke("hi");
    expect(String(r.content)).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toContain("/v1beta/models/gemini-x:generateContent");
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
