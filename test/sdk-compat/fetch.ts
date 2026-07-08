import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Unstable_DevWorker } from "wrangler";
import {
  FAKE,
  type MockUpstream,
  seedToken,
  startMockUpstream,
  startWorker,
} from "./setup";

// Raw fetch (no SDK) - covers the two things no official SDK exercises: the Gemini
// `?key=` query-param auth slot, verbatim request-body forwarding, and the CORS preflight.
let mock: MockUpstream;
let worker: Unstable_DevWorker;
let url: string;

beforeAll(async () => {
  mock = await startMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  url = w.url;
  await seedToken(url, { token: "tk-fetch", providers: ["gemini"] });
});
afterAll(async () => {
  await worker.stop();
  await mock.close();
});
beforeEach(() => mock.reset());

describe("raw fetch (no SDK)", () => {
  it("routes the Gemini ?key= slot, strips the token, swaps the real key, forwards body verbatim", async () => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: "ping-verbatim-42" }] }],
    });
    const res = await fetch(
      `${url}/v1beta/models/gemini-x:generateContent?key=tk-fetch&foo=bar`,
      { method: "POST", headers: { "content-type": "application/json" }, body },
    );
    expect(res.status).toBe(200);

    const cap = mock.last();
    expect(cap).not.toBeNull();
    // real key swapped into the header slot
    expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
    // the ?key= token is stripped from the forwarded query; other params survive
    expect(cap?.path).not.toContain("tk-fetch");
    expect(cap?.path).not.toContain("key=");
    expect(cap?.path).toContain("foo=bar");
    // the token never appears in any outbound header
    expect(JSON.stringify(cap?.headers)).not.toContain("tk-fetch");
    // request body forwarded byte-for-byte
    expect(cap?.body).toBe(body);
  });

  it("answers a CORS preflight (OPTIONS) at the edge without a token or upstream call", async () => {
    const res = await fetch(`${url}/v1/messages`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-headers": "x-api-key, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(mock.last()).toBeNull();
  });
});
