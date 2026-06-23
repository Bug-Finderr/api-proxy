import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const py =
  process.platform === "win32"
    ? join(repo, ".venv", "Scripts", "python.exe")
    : join(repo, ".venv", "bin", "python");
const dir = join(repo, "test", "sdk-compat");

if (!existsSync(py)) {
  console.log(
    "[py] .venv not found - skipping. Setup: python -m venv .venv && " +
      ".venv/Scripts/python -m pip install -r test/requirements.txt",
  );
  process.exit(0);
}

const pyFiles = readdirSync(dir)
  .filter((f) => f.endsWith(".py"))
  .sort();
if (pyFiles.length === 0) process.exit(0);

const FAKE = {
  openai: "FAKE-OPENAI-KEY",
  anthropic: "FAKE-ANTHROPIC-KEY",
  gemini: "FAKE-GEMINI-KEY",
};
const ADMIN_SECRET = "compat-admin-secret";
const TOKEN = "tk-py";
const PER_FILE_TIMEOUT_MS = 90_000;

// --- mock upstream (mirrors test/sdk-compat/setup.ts, plus control endpoints) ---
let captured = null;

function providerFromPath(path) {
  if (path.includes("/v1beta/openai/")) return "openai";
  if (
    path.includes(":generateContent") ||
    path.includes(":streamGenerateContent")
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

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = req.url ?? "";
      // control endpoints - the Python test reads/clears the capture over HTTP
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
        captured = {
          method: req.method ?? "",
          path,
          headers: req.headers,
          body,
        };
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
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function seedToken(workerUrl) {
  const login = await fetch(`${workerUrl}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_SECRET }).toString(),
  });
  if (login.status !== 200)
    throw new Error(`admin login failed: ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const form = new URLSearchParams({ label: TOKEN, token: TOKEN });
  for (const p of ["openai", "anthropic", "gemini"])
    form.append("providers", p);
  const res = await fetch(`${workerUrl}/admin/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: form.toString(),
  });
  if (res.status !== 200) throw new Error(`seed token failed: ${res.status}`);
}

const mock = await startMock();
const worker = await unstable_dev("src/index.ts", {
  config: "wrangler.toml",
  local: true,
  vars: {
    OPENAI_API_KEY: FAKE.openai,
    ANTHROPIC_API_KEY: FAKE.anthropic,
    GEMINI_API_KEY: FAKE.gemini,
    ADMIN_SECRET,
    OPENAI_UPSTREAM: mock.url,
    ANTHROPIC_UPSTREAM: mock.url,
    GEMINI_UPSTREAM: mock.url,
  },
  experimental: { disableExperimentalWarning: true },
});
// Normalize the bind address: unstable_dev can report 0.0.0.0 / :: (which Node's fetch
// tolerates but Python's HTTP clients do not, hanging on their long default timeout).
const host =
  !worker.address || worker.address === "0.0.0.0" || worker.address === "::"
    ? "127.0.0.1"
    : worker.address;
const workerUrl = `http://${host}:${worker.port}`;
console.log(`[py] worker ${workerUrl}  mock ${mock.url}`);

let failed = 0;
try {
  await seedToken(workerUrl);
  const env = {
    ...process.env,
    PROXY_WORKER_URL: workerUrl,
    PROXY_MOCK_URL: mock.url,
    PROXY_TOKEN: TOKEN,
    PROXY_FAKE_OPENAI: FAKE.openai,
    PROXY_FAKE_ANTHROPIC: FAKE.anthropic,
    PROXY_FAKE_GEMINI: FAKE.gemini,
  };
  for (const file of pyFiles) {
    captured = null;
    console.log(`[py] ${file}`);
    // Async spawn (NOT spawnSync): the mock lives in this event loop, and spawnSync would freeze
    // it for the whole child run - so the worker could never reach the mock and every test would
    // hang. Await exit via a Promise, with a hard timeout that kills a stuck child.
    const code = await new Promise((resolve) => {
      const child = spawn(py, [join(dir, file)], { stdio: "inherit", env });
      const timer = setTimeout(() => {
        console.error(
          `[py] ${file} TIMED OUT after ${PER_FILE_TIMEOUT_MS / 1000}s`,
        );
        child.kill("SIGKILL");
      }, PER_FILE_TIMEOUT_MS);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c ?? 1);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        console.error(`[py] ${file} spawn error: ${e.message}`);
        resolve(1);
      });
    });
    if (code !== 0) failed++;
  }
} finally {
  await worker.stop();
  mock.close();
}

process.exit(failed ? 1 : 0);
