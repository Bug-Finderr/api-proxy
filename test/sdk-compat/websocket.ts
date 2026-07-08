import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Unstable_DevWorker } from "wrangler";
import { WebSocket, WebSocketServer } from "ws";
import { FAKE, seedToken, startWorker } from "./setup";

// Real end-to-end wss proxy: a `ws` client -> the worker (real upgrade) -> a `ws` mock upstream.
// Proves the outbound WS upgrade works in workerd, the real key reaches the upstream handshake,
// the proxy token never does, and frames flow both ways. The per-slot swap detail (subprotocol
// stripping etc.) is covered fast in the tier-1 test/ws.test.ts; here we prove the live socket.

interface Handshake {
  headers: http.IncomingHttpHeaders;
  url: string;
}

interface WsMock {
  url: string;
  last(): Handshake | null;
  reset(): void;
  close(): Promise<void>;
}

async function startWsMockUpstream(): Promise<WsMock> {
  let last: Handshake | null = null;
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    last = { headers: req.headers, url: req.url ?? "" };
    // Echo every frame straight back (binary-preserving).
    socket.on("message", (data, isBinary) =>
      socket.send(data, { binary: isBinary }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    last: () => last,
    reset: () => {
      last = null;
    },
    close: () =>
      new Promise<void>((res) => wss.close(() => server.close(() => res()))),
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
  // unstable_dev can report 0.0.0.0 / :: which a raw ws client cannot dial.
  const host =
    !worker.address || worker.address === "0.0.0.0" || worker.address === "::"
      ? "127.0.0.1"
      : worker.address;
  wsBase = `ws://${host}:${worker.port}`;
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

/** Open a proxied socket, send one frame, resolve with the echoed frame. */
function roundtrip(
  path: string,
  opts?: ConstructorParameters<typeof WebSocket>[2],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const c = new WebSocket(`${wsBase}${path}`, opts);
    const timer = setTimeout(() => {
      c.terminate();
      reject(new Error("ws round-trip timed out"));
    }, 15_000);
    c.on("open", () => c.send(JSON.stringify({ type: "ping" })));
    c.on("message", (data) => {
      clearTimeout(timer);
      c.close();
      resolve(JSON.parse(data.toString()));
    });
    c.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe("WebSocket proxy (end-to-end)", () => {
  it("OpenAI Bearer: upgrades, swaps the real key into the handshake, echoes frames", async () => {
    mock.reset();
    const echo = await roundtrip("/v1/responses", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(echo).toEqual({ type: "ping" });
    const hs = mock.last();
    expect(hs).not.toBeNull();
    expect(hs!.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
    expect(JSON.stringify(hs)).not.toContain(TOKEN); // proxy token never reaches upstream
  });

  it("Gemini ?key=: upgrades with the query key swapped to the real key", async () => {
    mock.reset();
    const echo = await roundtrip(
      `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${TOKEN}`,
    );
    expect(echo).toEqual({ type: "ping" });
    const hs = mock.last();
    expect(hs).not.toBeNull();
    expect(hs!.url).toContain(`key=${FAKE.gemini}`);
    expect(hs!.url).not.toContain(TOKEN);
    expect(hs!.headers.authorization).toBeUndefined();
  });

  it("preserves binary frames byte-for-byte through the pipe", async () => {
    mock.reset();
    // Pins byte-for-byte binary transit. At the current compatibility_date the workerd default
    // is already arraybuffer; once the date passes 2026-03-17 (websocket_standard_binary_type
    // flips the default to Blob) the explicit binaryType pin in ws.ts becomes load-bearing and
    // this test is what catches its removal.
    const payload = Uint8Array.from([0, 1, 2, 127, 128, 250, 255, 42]);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      const c = new WebSocket(`${wsBase}/v1/responses`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const timer = setTimeout(() => {
        c.terminate();
        reject(new Error("binary round-trip timed out"));
      }, 15_000);
      c.on("open", () => c.send(payload));
      c.on("message", (data, isBinary) => {
        clearTimeout(timer);
        c.close();
        if (isBinary) resolve(data as Buffer);
        else reject(new Error("frame came back as text"));
      });
      c.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    expect(Buffer.from(echoed).equals(Buffer.from(payload))).toBe(true);
  });

  it("rejects an unknown token at the handshake (upstream never opened)", async () => {
    mock.reset();
    await expect(
      roundtrip("/v1/responses", {
        headers: { authorization: "Bearer ghost" },
      }),
    ).rejects.toThrow();
    expect(mock.last()).toBeNull();
  });
});
