import { defineConfig } from "vitest/config";

// Tier 2 runs each real Node SDK against its own local worker and mock upstream.
// Python clients use the shared harness through `nub run test:py`.
export default defineConfig({
  test: {
    include: ["test/sdk-compat/*.ts"],
    exclude: ["test/sdk-compat/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
