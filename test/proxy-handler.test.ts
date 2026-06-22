import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { createToken, updateToken } from "../src/tokens";

let captured: Request | null;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	captured = null;
	fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		captured = input instanceof Request ? input : new Request(input, init);
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	});
});
afterEach(() => vi.restoreAllMocks());

async function call(req: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const seed = (token: string, providers: ("openai" | "anthropic" | "gemini")[]) =>
	createToken(env.TOKENS, { label: token, providers, token });

describe("proxy routing + key swap", () => {
	it("forwards a valid OpenAI request with the real key swapped in", async () => {
		await seed("tk-oai", ["openai"]);
		const res = await call(
			new Request("https://proxy.example/v1/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer tk-oai", "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-x", messages: [] }),
			}),
		);
		expect(res.status).toBe(200);
		const u = new URL(captured!.url);
		expect(u.hostname).toBe("api.openai.com");
		expect(u.pathname).toBe("/v1/chat/completions");
		expect(captured!.headers.get("authorization")).toBe("Bearer real-openai-key-FAKE");
	});

	it("forwards a valid Anthropic request swapping x-api-key and passing other headers through", async () => {
		await seed("tk-anth", ["anthropic"]);
		const res = await call(
			new Request("https://proxy.example/v1/messages", {
				method: "POST",
				headers: { "x-api-key": "tk-anth", "anthropic-version": "2023-06-01" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(200);
		expect(new URL(captured!.url).hostname).toBe("api.anthropic.com");
		expect(captured!.headers.get("x-api-key")).toBe("real-anthropic-key-FAKE");
		expect(captured!.headers.get("anthropic-version")).toBe("2023-06-01");
	});

	it("forwards a Gemini request swapping x-goog-api-key, dropping ?key=, preserving other query", async () => {
		await seed("tk-gem", ["gemini"]);
		const res = await call(
			new Request("https://proxy.example/v1beta/models/g:generateContent?key=tk-gem&alt=sse", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(200);
		const u = new URL(captured!.url);
		expect(u.hostname).toBe("generativelanguage.googleapis.com");
		expect(u.searchParams.get("key")).toBeNull();
		expect(u.searchParams.get("alt")).toBe("sse");
		expect(captured!.headers.get("x-goog-api-key")).toBe("real-gemini-key-FAKE");
	});

	it("routes the Gemini OpenAI-compat path via bearer to the gemini upstream", async () => {
		await seed("tk-gem2", ["gemini"]);
		const res = await call(
			new Request("https://proxy.example/v1beta/openai/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer tk-gem2" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(200);
		expect(new URL(captured!.url).hostname).toBe("generativelanguage.googleapis.com");
		expect(captured!.headers.get("authorization")).toBe("Bearer real-gemini-key-FAKE");
	});
});

describe("auth failures (upstream never called)", () => {
	it("401 when no token is present", async () => {
		const res = await call(new Request("https://proxy.example/v1/chat/completions", { method: "POST", body: "{}" }));
		expect(res.status).toBe(401);
		expect(captured).toBeNull();
	});
	it("401 for an unknown token", async () => {
		const res = await call(
			new Request("https://proxy.example/v1/messages", { method: "POST", headers: { "x-api-key": "ghost" }, body: "{}" }),
		);
		expect(res.status).toBe(401);
		expect(captured).toBeNull();
	});
	it("401 for a disabled token", async () => {
		const { hash } = await createToken(env.TOKENS, { label: "d", providers: ["openai"], token: "tk-disabled" });
		await updateToken(env.TOKENS, hash, { status: "disabled" });
		const res = await call(
			new Request("https://proxy.example/v1/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer tk-disabled" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(401);
		expect(captured).toBeNull();
	});
	it("403 when the token is not scoped to the requested provider", async () => {
		await createToken(env.TOKENS, { label: "s", providers: ["openai"], token: "tk-oai-only" });
		const res = await call(
			new Request("https://proxy.example/v1/messages", {
				method: "POST",
				headers: { "x-api-key": "tk-oai-only" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(403);
		expect(captured).toBeNull();
	});
});

describe("security invariant", () => {
	it("never forwards the doppelganger token upstream", async () => {
		await createToken(env.TOKENS, { label: "sec", providers: ["openai"], token: "SECRET-DOPPEL" });
		await call(
			new Request("https://proxy.example/v1/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer SECRET-DOPPEL" },
				body: "{}",
			}),
		);
		const slots = [
			captured!.headers.get("authorization"),
			captured!.headers.get("x-api-key"),
			captured!.headers.get("x-goog-api-key"),
		].join("|");
		expect(slots).not.toContain("SECRET-DOPPEL");
	});
});

describe("OpenAI geo-403 fallback via the US egress DO", () => {
	const realEgress = env.US_EGRESS;
	let egressCalls: Request[];
	afterEach(() => {
		(env as { US_EGRESS: typeof realEgress }).US_EGRESS = realEgress;
	});

	// Replace the DO namespace with a fake whose stub.fetch records the request and returns 200.
	function fakeEgress() {
		egressCalls = [];
		const stub = {
			fetch: async (r: Request) => {
				egressCalls.push(r);
				return new Response(JSON.stringify({ ok: "via-egress" }), { status: 200 });
			},
		};
		(env as { US_EGRESS: unknown }).US_EGRESS = {
			idFromName: () => ({}),
			get: () => stub,
		};
	}

	const geo403 = () =>
		new Response(JSON.stringify({ error: { code: "unsupported_country_region_territory" } }), { status: 403 });

	it("retries through the egress DO when OpenAI returns a geo-403, with the real key", async () => {
		await seed("tk-geo", ["openai"]);
		fakeEgress();
		fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = input instanceof Request ? input : new Request(input, init);
			return geo403();
		});
		const res = await call(
			new Request("https://proxy.example/v1/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer tk-geo", "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }),
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: "via-egress" });
		expect(egressCalls.length).toBe(1);
		const sent = egressCalls[0];
		expect(new URL(sent.url).hostname).toBe("api.openai.com");
		expect(sent.headers.get("authorization")).toBe("Bearer real-openai-key-FAKE");
		expect(await sent.text()).toContain("hi"); // buffered body survived to the retry
	});

	it("does NOT retry on a non-geo 403 (passes it through)", async () => {
		await seed("tk-403", ["openai"]);
		fakeEgress();
		fetchSpy.mockImplementation(async () =>
			new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 403 }),
		);
		const res = await call(
			new Request("https://proxy.example/v1/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer tk-403" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(403);
		expect(egressCalls.length).toBe(0);
	});

	it("never routes non-OpenAI providers through the egress DO", async () => {
		await seed("tk-anth-geo", ["anthropic"]);
		fakeEgress();
		fetchSpy.mockImplementation(async () => geo403());
		const res = await call(
			new Request("https://proxy.example/v1/messages", {
				method: "POST",
				headers: { "x-api-key": "tk-anth-geo" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(403); // anthropic 403 passes straight through
		expect(egressCalls.length).toBe(0);
	});
});

describe("SSE passthrough", () => {
	it("streams text/event-stream chunks through without buffering", async () => {
		await createToken(env.TOKENS, { label: "sse", providers: ["openai"], token: "tk-sse" });
		fetchSpy.mockImplementation(async () => {
			const enc = new TextEncoder();
			const stream = new ReadableStream({
				start(c) {
					c.enqueue(enc.encode("data: a\n\n"));
					c.enqueue(enc.encode("data: b\n\n"));
					c.enqueue(enc.encode("data: [DONE]\n\n"));
					c.close();
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		const res = await call(
			new Request("https://proxy.example/v1/chat/completions", {
				method: "POST",
				headers: { authorization: "Bearer tk-sse" },
				body: "{}",
			}),
		);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const text = await res.text();
		expect(text).toContain("data: a");
		expect(text).toContain("[DONE]");
	});
});
