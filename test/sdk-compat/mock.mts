// Shared by both compat tiers; run-py.mjs loads it under vanilla node (Node strips the types natively).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { unstable_startWorker } from "wrangler";

export type TestWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

export const FAKE = {
  openai: "FAKE-OPENAI-KEY",
  anthropic: "FAKE-ANTHROPIC-KEY",
  gemini: "FAKE-GEMINI-KEY",
};
export const ADMIN_SECRET = "compat-admin-secret";

export interface Captured {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockUpstream {
  url: string;
  last(): Captured | null;
  reset(): void;
  close(): Promise<void>;
}

function providerFromPath(path: string): string {
  if (path.includes("/v1beta/openai/")) return "openai"; // gemini OpenAI-compat uses OpenAI shape
  if (
    path.includes(":generateContent") ||
    path.includes(":streamGenerateContent") ||
    path.startsWith("/v1beta/")
  )
    return "gemini";
  if (path.includes("/v1/messages")) return "anthropic";
  return "openai";
}

function bodyFor(provider: string): unknown {
  if (provider === "anthropic")
    return {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "x",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  if (provider === "gemini")
    return {
      candidates: [
        {
          content: { parts: [{ text: "hi" }], role: "model" },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
    };
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 0,
    model: "x",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function writeSse(res: http.ServerResponse, provider: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  if (provider === "anthropic") {
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    );
    res.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    );
    res.write(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    );
    res.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    );
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  } else if (provider === "gemini") {
    res.write(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"},"finishReason":"STOP"}]}\n\n',
    );
  } else {
    res.write(
      'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
    );
    res.write(
      'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    );
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

export async function startMockUpstream(): Promise<MockUpstream> {
  let captured: Captured | null = null;
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    // Control endpoints: the Python tier reads/clears the capture over HTTP.
    if (path === "/__captured") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(captured));
      return;
    }
    if (path === "/__reset") {
      captured = null;
      res.writeHead(204);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      captured = { method: req.method ?? "", path, headers: req.headers, body };
      const provider = providerFromPath(path);
      const stream =
        path.includes("streamGenerateContent") ||
        /[?&]alt=sse/.test(path) ||
        /"stream"\s*:\s*true/.test(body);
      if (stream) return writeSse(res, provider);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(bodyFor(provider)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    last: () => captured,
    reset: () => {
      captured = null;
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

export async function startWorker(mockUrl: string): Promise<{
  worker: TestWorker;
  url: string;
  wsUrl: string;
}> {
  const worker = await unstable_startWorker({
    config: "wrangler.toml",
    bindings: {
      OPENAI_API_KEY: { type: "plain_text", value: FAKE.openai },
      ANTHROPIC_API_KEY: { type: "plain_text", value: FAKE.anthropic },
      GEMINI_API_KEY: { type: "plain_text", value: FAKE.gemini },
      ADMIN_SECRET: { type: "plain_text", value: ADMIN_SECRET },
      OPENAI_UPSTREAM: { type: "plain_text", value: mockUrl },
      ANTHROPIC_UPSTREAM: { type: "plain_text", value: mockUrl },
      GEMINI_UPSTREAM: { type: "plain_text", value: mockUrl },
    },
    dev: {
      remote: false,
      server: { hostname: "127.0.0.1", port: 0 },
      persist: false,
      watch: false,
      inspector: false,
      logLevel: "error",
    },
  });
  try {
    const url = await worker.url;
    return {
      worker,
      url: url.origin,
      wsUrl: url.origin.replace(/^http/, "ws"),
    };
  } catch (error) {
    await worker.dispose().catch(() => undefined);
    throw error;
  }
}

export async function seedToken(
  url: string,
  opts: { token: string; providers: string[]; label?: string },
): Promise<void> {
  const login = await fetch(`${url}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_SECRET }).toString(),
  });
  if (login.status !== 200)
    throw new Error(`admin login failed: ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const body = new URLSearchParams();
  body.set("label", opts.label ?? opts.token);
  body.set("token", opts.token);
  for (const p of opts.providers) body.append("providers", p);
  const res = await fetch(`${url}/admin/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: body.toString(),
  });
  if (res.status !== 200) throw new Error(`seed token failed: ${res.status}`);
}
