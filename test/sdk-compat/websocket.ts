import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Unstable_DevWorker } from "wrangler";
import { WebSocket, WebSocketServer } from "ws";
import { FAKE, seedToken, startWorker } from "./mock.mts";

// live end-to-end socket proof; per-slot swap details are covered in test/ws.test.ts

interface Handshake {
  headers: http.IncomingHttpHeaders;
  url: string;
}

interface WsMock {
  url: string;
  last(): Handshake | null;
  current(): WebSocket | null;
  reset(): void;
  close(): Promise<void>;
}

async function startWsMockUpstream(): Promise<WsMock> {
  let last: Handshake | null = null;
  let current: WebSocket | null = null;
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    last = { headers: req.headers, url: req.url ?? "" };
    current = socket;
    socket.on("message", (data, isBinary) =>
      socket.send(data, { binary: isBinary }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    last: () => last,
    current: () => current,
    reset: () => {
      last = null;
      current?.terminate();
      current = null;
    },
    close: () => {
      current?.terminate();
      return new Promise<void>((res) =>
        wss.close(() => server.close(() => res())),
      );
    },
  };
}

let mock: WsMock;
let worker: Unstable_DevWorker;
let wsBase: string;
const TOKEN = "compat-ws-token";

beforeAll(async () => {
  mock = await startWsMockUpstream();
  const w = await startWorker(mock.url);
  worker = w.worker;
  wsBase = w.wsUrl;
  await seedToken(w.url, {
    token: TOKEN,
    providers: ["openai", "gemini"],
    label: "ws",
  });
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
});

beforeEach(() => mock.reset());

const ping = JSON.stringify({ type: "ping" });
const TIMEOUT_MS = 15_000;

function roundtrip(
  path: string,
  payload: string | Uint8Array,
  opts?: ConstructorParameters<typeof WebSocket>[2],
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const c = new WebSocket(`${wsBase}${path}`, opts);
    const timer = setTimeout(() => {
      c.terminate();
      reject(new Error("ws round-trip timed out"));
    }, TIMEOUT_MS);
    c.on("open", () => c.send(payload));
    c.on("message", (data, isBinary) => {
      clearTimeout(timer);
      c.close();
      resolve({ data: data as Buffer, isBinary });
    });
    c.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function closeRoundtrip(
  source: "client" | "upstream",
  code: number,
  reason: string,
): Promise<{ code: number; reason: string }> {
  const client = new WebSocket(`${wsBase}/v1/responses`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("ws close propagation timed out")),
      TIMEOUT_MS,
    );
    client.once("error", reject);
    client.once("open", () => {
      const upstream = mock.current();
      if (!upstream) return reject(new Error("mock upstream socket missing"));
      const destination = source === "client" ? upstream : client;
      destination.once("close", (receivedCode, receivedReason) => {
        resolve({ code: receivedCode, reason: receivedReason.toString() });
      });
      (source === "client" ? client : upstream).close(code, reason);
    });
  }).finally(() => {
    clearTimeout(timer);
    client.terminate();
    mock.reset();
  });
}

describe("WebSocket proxy (end-to-end)", () => {
  it("OpenAI Bearer: upgrades, swaps the real key into the handshake, echoes frames", async () => {
    const { data } = await roundtrip("/v1/responses", ping, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(JSON.parse(data.toString())).toEqual({ type: "ping" });
    const hs = mock.last();
    expect(hs).not.toBeNull();
    expect(hs!.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
    expect(JSON.stringify(hs)).not.toContain(TOKEN);
  });

  it("Gemini ?key=: upgrades with the query key swapped to the real key", async () => {
    const { data } = await roundtrip(
      `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${TOKEN}`,
      ping,
    );
    expect(JSON.parse(data.toString())).toEqual({ type: "ping" });
    const hs = mock.last();
    expect(hs).not.toBeNull();
    expect(hs!.url).toContain(`key=${FAKE.gemini}`);
    expect(hs!.url).not.toContain(TOKEN);
    expect(hs!.headers.authorization).toBeUndefined();
  });

  it("preserves binary frames byte-for-byte through the pipe", async () => {
    // once compatibility_date passes 2026-03-17 the workerd default flips to Blob;
    // this catches removal of the binaryType pin in ws.ts
    const payload = Uint8Array.from([0, 1, 2, 127, 128, 250, 255, 42]);
    const { data, isBinary } = await roundtrip("/v1/responses", payload, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(isBinary).toBe(true);
    expect(Buffer.from(data).equals(Buffer.from(payload))).toBe(true);
  });

  it.each([
    ["upstream", 4101, "upstream finished"],
    ["client", 4102, "client finished"],
  ] as const)("propagates a %s close code and reason", async (source, code, reason) => {
    expect(await closeRoundtrip(source, code, reason)).toEqual({
      code,
      reason,
    });
  });

  it("rejects an unknown token at the handshake (upstream never opened)", async () => {
    await expect(
      roundtrip("/v1/responses", ping, {
        headers: { authorization: "Bearer ghost" },
      }),
    ).rejects.toThrow();
    expect(mock.last()).toBeNull();
  });
});
