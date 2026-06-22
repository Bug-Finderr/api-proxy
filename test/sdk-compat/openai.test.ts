import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import OpenAI from "openai";
import { startMockUpstream, startWorker, seedToken, FAKE, type MockUpstream } from "./setup";
import type { Unstable_DevWorker } from "wrangler";

let mock: MockUpstream;
let worker: Unstable_DevWorker;
let baseURL: string;
const TOKEN = "compat-openai-token";

beforeAll(async () => {
	mock = await startMockUpstream();
	const w = await startWorker(mock.url);
	worker = w.worker;
	baseURL = w.url;
	await seedToken(baseURL, { token: TOKEN, providers: ["openai"], label: "openai" });
});

afterAll(async () => {
	await worker?.stop();
	await mock?.close();
});

beforeEach(() => mock.reset());

const client = () => new OpenAI({ baseURL: `${baseURL}/v1`, apiKey: TOKEN });

describe("openai SDK compatibility", () => {
	it("forwards a chat completion with the real key swapped in and the token absent", async () => {
		const r = await client().chat.completions.create({
			model: "gpt-x",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(r).toBeTruthy();
		const cap = mock.last();
		expect(cap?.path).toBe("/v1/chat/completions");
		expect(cap?.headers["authorization"]).toBe(`Bearer ${FAKE.openai}`);
		expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
	});

	it("streams a chat completion through the proxy", async () => {
		const stream = await client().chat.completions.create({
			model: "gpt-x",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		let text = "";
		for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content ?? "";
		expect(text).toContain("hi");
		expect(mock.last()?.headers["authorization"]).toBe(`Bearer ${FAKE.openai}`);
	});
});
