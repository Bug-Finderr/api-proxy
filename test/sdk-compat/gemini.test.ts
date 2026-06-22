import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { startMockUpstream, startWorker, seedToken, FAKE, type MockUpstream } from "./setup";
import type { Unstable_DevWorker } from "wrangler";

let mock: MockUpstream;
let worker: Unstable_DevWorker;
let baseURL: string;
const TOKEN = "compat-gemini-token";

beforeAll(async () => {
	mock = await startMockUpstream();
	const w = await startWorker(mock.url);
	worker = w.worker;
	baseURL = w.url;
	await seedToken(baseURL, { token: TOKEN, providers: ["gemini"], label: "gemini" });
});

afterAll(async () => {
	await worker?.stop();
	await mock?.close();
});

beforeEach(() => mock.reset());

describe("google genai SDK compatibility", () => {
	const ai = () => new GoogleGenAI({ apiKey: TOKEN, httpOptions: { baseUrl: baseURL } });

	it("forwards generateContent with x-goog-api-key swapped and the token absent", async () => {
		const r = await ai().models.generateContent({ model: "gemini-2.5-flash", contents: "hi" });
		expect(r).toBeTruthy();
		const cap = mock.last();
		expect(cap?.path).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
		expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
		expect(cap?.path).not.toContain(TOKEN); // ?key= (if used) is stripped
		expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
	});

	it("streams generateContent through the proxy (alt=sse preserved)", async () => {
		const stream = await ai().models.generateContentStream({ model: "gemini-2.5-flash", contents: "hi" });
		let text = "";
		for await (const chunk of stream) text += chunk.text ?? "";
		expect(text).toContain("hi");
		const cap = mock.last();
		expect(cap?.path).toContain("streamGenerateContent");
		expect(cap?.path).toContain("alt=sse");
		expect(cap?.headers["x-goog-api-key"]).toBe(FAKE.gemini);
	});
});

describe("gemini via the OpenAI-compat route", () => {
	// OpenAI SDK pointed at /v1beta/openai — token in Authorization: Bearer, scoped to gemini.
	const oai = () => new OpenAI({ baseURL: `${baseURL}/v1beta/openai`, apiKey: TOKEN });

	it("routes to the gemini upstream with the real gemini key as a bearer token", async () => {
		const r = await oai().chat.completions.create({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(r).toBeTruthy();
		const cap = mock.last();
		expect(cap?.path).toBe("/v1beta/openai/chat/completions");
		expect(cap?.headers["authorization"]).toBe(`Bearer ${FAKE.gemini}`);
		expect(JSON.stringify(cap?.headers)).not.toContain(TOKEN);
	});
});
