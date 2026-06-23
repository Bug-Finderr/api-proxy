// Runs every Python compat test in test/sdk-compat/ with the repo's .venv (wired into `nub run test`
// as `test:py`). Skips - non-fatal - if the venv isn't set up, so `nub run test` works without Python.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".py"))
  .sort()) {
  console.log(`[py] ${file}`);
  const r = spawnSync(py, [join(dir, file)], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
