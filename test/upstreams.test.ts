import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { rewriteToUpstream, upstreamBase } from "../src/upstreams";

const bare = {} as Env;

describe("upstreamBase", () => {
  it("defaults to the real hosts when no override is set", () => {
    expect(upstreamBase("openai", bare)).toBe("https://api.openai.com");
    expect(upstreamBase("anthropic", bare)).toBe("https://api.anthropic.com");
    expect(upstreamBase("gemini", bare)).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });
  it("maps gemini-openai to the gemini upstream", () => {
    expect(upstreamBase("gemini-openai", bare)).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });
  it("honors env overrides", () => {
    const env = { OPENAI_UPSTREAM: "http://127.0.0.1:9999" } as Env;
    expect(upstreamBase("openai", env)).toBe("http://127.0.0.1:9999");
  });
});

describe("rewriteToUpstream", () => {
  it("rewrites protocol/host but preserves path and query", () => {
    const url = new URL("https://proxy.example/v1/chat/completions?foo=bar");
    rewriteToUpstream(url, "openai", bare);
    expect(url.hostname).toBe("api.openai.com");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/v1/chat/completions");
    expect(url.search).toBe("?foo=bar");
  });
  it("targets a localhost override with port (the test seam)", () => {
    const env = { GEMINI_UPSTREAM: "http://127.0.0.1:9100" } as Env;
    const url = new URL(
      "https://proxy.example/v1beta/models/x:streamGenerateContent?alt=sse",
    );
    rewriteToUpstream(url, "gemini", env);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("9100");
    expect(url.pathname).toBe("/v1beta/models/x:streamGenerateContent");
    expect(url.search).toBe("?alt=sse");
  });
});
