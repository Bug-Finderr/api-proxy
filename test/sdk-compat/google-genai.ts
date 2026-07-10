import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

const TOKEN = "compat-gemini-token";
const h = compatHarness({
  token: TOKEN,
  providers: ["gemini"],
});

describe("google genai SDK compatibility", () => {
  const ai = () =>
    new GoogleGenAI({ apiKey: TOKEN, httpOptions: { baseUrl: h.url() } });

  it("forwards generateContent with x-goog-api-key swapped and the token absent", async () => {
    const r = await ai().models.generateContent({
      model: "gemini-2.5-flash",
      contents: "hi",
    });
    expect(r).toBeTruthy();
    const cap = h.last();
    expect(cap?.path).toContain(
      "/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    expect(cap?.path).not.toContain(TOKEN);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });

  it("streams generateContent through the proxy (alt=sse preserved)", async () => {
    const stream = await ai().models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: "hi",
    });
    let text = "";
    for await (const chunk of stream) text += chunk.text ?? "";
    expect(text).toContain("hi");
    const cap = h.last();
    expect(cap?.path).toContain("streamGenerateContent");
    expect(cap?.path).toContain("alt=sse");
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
  });
});

describe("gemini via the OpenAI-compat route", () => {
  const oai = () =>
    new OpenAI({ baseURL: `${h.url()}/v1beta/openai`, apiKey: TOKEN });

  it("routes to the gemini upstream with the real gemini key as a bearer token", async () => {
    const r = await oai().chat.completions.create({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).toBeTruthy();
    const cap = h.last();
    expect(cap?.path).toBe("/v1beta/openai/chat/completions");
    expect(cap?.headers.authorization).toBe(`Bearer ${FAKE.gemini}`);
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
  });
});
