import { configDefaults, defineConfig } from "vitest/config";

// Tier 2: real-SDK compatibility. Runs in Node (the SDKs run here), hits a locally
// started worker whose *_UPSTREAM env points at a node:http mock. Serial to avoid
// shared-capture-state and port races. Each test file is named after the client it drives;
// setup.ts is the shared harness (excluded). Python clients run separately (`nub run test:py`).
export default defineConfig({
  test: {
    include: ["test/sdk-compat/*.ts"],
    exclude: [...configDefaults.exclude, "test/sdk-compat/setup.ts"],
    pool: "forks",
    fileParallelism: false, // serial: each file owns a mock upstream + worker on its own port
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
