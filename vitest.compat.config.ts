import { defineConfig } from "vitest/config";

// Tier 2: real-SDK compatibility. Runs in Node (the SDKs run here), hits a locally
// started worker whose *_UPSTREAM env points at a node:http mock. Each test file is
// named after the client it drives and owns its worker and mock upstream;
// setup.ts is the shared harness (excluded). Python clients run separately (`nub run test:py`).
export default defineConfig({
  test: {
    include: ["test/sdk-compat/*.ts"],
    exclude: ["test/sdk-compat/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
