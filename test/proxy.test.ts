import { describe, expect, it } from "vitest";
import {
  coarse,
  extractToken,
  realKeyFor,
  routeProvider,
  swapAuth,
} from "../src/proxy";
import type { Env } from "../src/types";

function ctx(
  headers: Record<string, string>,
  urlStr = "https://proxy.example/v1/chat/completions",
) {
  return { req: new Request(urlStr, { headers }), url: new URL(urlStr) };
}

describe("extractToken", () => {
  it("reads the anthropic x-api-key slot", () => {
    const { req, url } = ctx(
      { "x-api-key": "tok_anth" },
      "https://proxy.example/v1/messages",
    );
    expect(extractToken(req, url)).toBe("tok_anth");
  });
  it("reads the gemini x-goog-api-key slot", () => {
    const { req, url } = ctx({ "x-goog-api-key": "tok_gem" });
    expect(extractToken(req, url)).toBe("tok_gem");
  });
  it("reads the bearer token from authorization", () => {
    const { req, url } = ctx({ authorization: "Bearer tok_oai" });
    expect(extractToken(req, url)).toBe("tok_oai");
  });
  it("reads ?key= for raw gemini REST callers", () => {
    const { req, url } = ctx(
      {},
      "https://proxy.example/v1beta/models/x:generateContent?key=tok_q",
    );
    expect(extractToken(req, url)).toBe("tok_q");
  });
  it("prefers x-api-key when both x-api-key and authorization are present (anthropic authToken case)", () => {
    const { req, url } = ctx({
      "x-api-key": "tok_anth",
      authorization: "Bearer tok_other",
    });
    expect(extractToken(req, url)).toBe("tok_anth");
  });
  it("returns null when no auth is present", () => {
    const { req, url } = ctx({});
    expect(extractToken(req, url)).toBeNull();
  });
});

describe("routeProvider", () => {
  it("routes x-api-key to anthropic", () => {
    const { req, url } = ctx(
      { "x-api-key": "t" },
      "https://proxy.example/v1/messages",
    );
    expect(routeProvider(req, url)).toBe("anthropic");
  });
  it("routes x-goog-api-key to gemini", () => {
    const { req, url } = ctx({ "x-goog-api-key": "t" });
    expect(routeProvider(req, url)).toBe("gemini");
  });
  it("routes bearer + normal path to openai", () => {
    const { req, url } = ctx(
      { authorization: "Bearer t" },
      "https://proxy.example/v1/chat/completions",
    );
    expect(routeProvider(req, url)).toBe("openai");
  });
  it("routes bearer + /v1beta/openai/ path to gemini-openai", () => {
    const { req, url } = ctx(
      { authorization: "Bearer t" },
      "https://proxy.example/v1beta/openai/chat/completions",
    );
    expect(routeProvider(req, url)).toBe("gemini-openai");
  });
  it("routes ?key= to gemini", () => {
    const { req, url } = ctx(
      {},
      "https://proxy.example/v1beta/models/x:generateContent?key=t",
    );
    expect(routeProvider(req, url)).toBe("gemini");
  });
  it("returns null when no provider can be determined", () => {
    const { req, url } = ctx({});
    expect(routeProvider(req, url)).toBeNull();
  });
});

describe("coarse", () => {
  it("maps gemini-openai to the gemini scope", () =>
    expect(coarse("gemini-openai")).toBe("gemini"));
  it("leaves openai/anthropic/gemini unchanged", () => {
    expect(coarse("openai")).toBe("openai");
    expect(coarse("anthropic")).toBe("anthropic");
    expect(coarse("gemini")).toBe("gemini");
  });
});

describe("swapAuth", () => {
  it("sets bearer for openai and strips the other slots", () => {
    const h = new Headers({
      authorization: "Bearer DOPPEL",
      "x-api-key": "DOPPEL",
      "x-goog-api-key": "DOPPEL",
    });
    swapAuth(h, "openai", "REALKEY");
    expect(h.get("authorization")).toBe("Bearer REALKEY");
    expect(h.get("x-api-key")).toBeNull();
    expect(h.get("x-goog-api-key")).toBeNull();
  });
  it("sets x-api-key for anthropic and strips the other slots", () => {
    const h = new Headers({
      authorization: "Bearer DOPPEL",
      "x-api-key": "DOPPEL",
    });
    swapAuth(h, "anthropic", "REALKEY");
    expect(h.get("x-api-key")).toBe("REALKEY");
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-goog-api-key")).toBeNull();
  });
  it("sets x-goog-api-key for gemini", () => {
    const h = new Headers({ "x-goog-api-key": "DOPPEL" });
    swapAuth(h, "gemini", "REALKEY");
    expect(h.get("x-goog-api-key")).toBe("REALKEY");
  });
  it("sets bearer for gemini-openai", () => {
    const h = new Headers({ authorization: "Bearer DOPPEL" });
    swapAuth(h, "gemini-openai", "REALKEY");
    expect(h.get("authorization")).toBe("Bearer REALKEY");
  });
  it("never leaves the doppelganger token in any auth header", () => {
    const h = new Headers({
      "x-api-key": "DOPPEL",
      authorization: "Bearer DOPPEL",
      "x-goog-api-key": "DOPPEL",
    });
    swapAuth(h, "anthropic", "REALKEY");
    const all = [
      h.get("authorization"),
      h.get("x-api-key"),
      h.get("x-goog-api-key"),
    ].join("|");
    expect(all).not.toContain("DOPPEL");
  });
});

describe("realKeyFor", () => {
  const env = {
    OPENAI_API_KEY: "oai",
    ANTHROPIC_API_KEY: "anth",
    GEMINI_API_KEY: "gem",
  } as Env;
  it("returns the right key per provider", () => {
    expect(realKeyFor("openai", env)).toBe("oai");
    expect(realKeyFor("anthropic", env)).toBe("anth");
    expect(realKeyFor("gemini", env)).toBe("gem");
    expect(realKeyFor("gemini-openai", env)).toBe("gem");
  });
});
