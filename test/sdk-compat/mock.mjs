// Single owner of the mock upstream + admin token seed for BOTH compat tiers: the vitest
// tier imports it through setup.ts, and test/run-py.mjs loads it under vanilla node (which
// is why this file is plain .mjs - types live in mock.d.mts).
import { createHash } from "node:crypto";
import http from "node:http";

// Fake real-keys injected as the worker's bindings. Tests assert these reach the mock
// upstream (proving the swap) and that the proxy token never does.
export const FAKE = {
  openai: "FAKE-OPENAI-KEY",
  anthropic: "FAKE-ANTHROPIC-KEY",
  gemini: "FAKE-GEMINI-KEY",
};
export const ADMIN_SECRET = "compat-admin-secret";

function providerFromPath(path) {
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

function bodyFor(provider) {
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

function writeSse(res, provider) {
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

export async function startMockUpstream() {
  let captured = null;
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
    const chunks = [];
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
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    last: () => captured,
    reset: () => {
      captured = null;
    },
    close: () => new Promise((res) => server.close(() => res())),
  };
}

export async function seedToken(url, opts) {
  const login = await fetch(`${url}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_SECRET }).toString(),
  });
  if (login.status !== 200)
    throw new Error(`admin login failed: ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  // Local dev KV persists across runs (.wrangler/state) and creation 409s on an existing
  // hash (overwrite guard), so make the seed idempotent: delete any stale record first.
  const hash = createHash("sha256").update(opts.token).digest("hex");
  await fetch(`${url}/admin/api/tokens/${hash}`, {
    method: "DELETE",
    headers: { cookie },
  });
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
