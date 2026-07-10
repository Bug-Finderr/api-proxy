import { describe, expect, it } from "vitest";
import { compatHarness, FAKE } from "./setup";

// covers what no SDK exercises: the Gemini ?key= auth slot and verbatim body forwarding
const TOKEN = "tk-fetch-compat";
const h = compatHarness({ token: TOKEN, providers: ["gemini"] });

describe("raw fetch (no SDK)", () => {
  it("routes the Gemini ?key= slot, strips the token, swaps the real key, forwards body verbatim", async () => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: "ping-verbatim-42" }] }],
    });
    const res = await fetch(
      `${h.url()}/v1beta/models/gemini-x:generateContent?key=${TOKEN}&foo=bar`,
      { method: "POST", headers: { "content-type": "application/json" }, body },
    );
    expect(res.status).toBe(200);

    const cap = h.last();
    expect(cap).not.toBeNull();
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    expect(cap?.path).not.toContain(TOKEN);
    expect(cap?.path).not.toContain("key=");
    expect(cap?.path).toContain("foo=bar");
    expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
    expect(cap?.body).toBe(body);
  });
});
