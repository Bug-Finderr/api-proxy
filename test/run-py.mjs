import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAKE,
  seedToken,
  startMockUpstream,
  startWorker,
} from "./sdk-compat/mock.mts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const py =
  process.platform === "win32"
    ? join(repo, ".venv", "Scripts", "python.exe")
    : join(repo, ".venv", "bin", "python");
const dir = join(repo, "test", "sdk-compat");

if (!existsSync(py)) {
  console.log(
    "[py] .venv not found - skipping. Setup: uv venv && uv pip install -r test/requirements.txt",
  );
  process.exit(0);
}

const pyFiles = readdirSync(dir)
  .filter((f) => f.endsWith(".py"))
  .sort();
if (pyFiles.length === 0) process.exit(0);

const TOKEN = "tk-py-compat-1";
const PER_FILE_TIMEOUT_MS = 90_000;

const mock = await startMockUpstream();
const { worker, url: workerUrl } = await startWorker(mock.url);
console.log(`[py] worker ${workerUrl}  mock ${mock.url}`);

let failed = 0;
try {
  await seedToken(workerUrl, {
    token: TOKEN,
    providers: ["openai", "anthropic", "gemini"],
  });
  const env = {
    ...process.env,
    PROXY_WORKER_URL: workerUrl,
    PROXY_MOCK_URL: mock.url,
    PROXY_TOKEN: TOKEN,
    PROXY_FAKE_OPENAI: FAKE.openai,
    PROXY_FAKE_ANTHROPIC: FAKE.anthropic,
    PROXY_FAKE_GEMINI: FAKE.gemini,
  };
  // strip real provider keys so an SDK reading env vars can't bypass the token path
  for (const k of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ])
    delete env[k];
  for (const file of pyFiles) {
    mock.reset();
    console.log(`[py] ${file}`);
    // async spawn: spawnSync would freeze this event loop and the mock with it, hanging every child
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
  await mock.close();
}

process.exit(failed ? 1 : 0);
