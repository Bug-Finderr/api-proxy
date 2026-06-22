import { defineConfig } from "vitest/config";

// Tier 2: real-SDK compatibility. Runs in Node (the SDKs run here), hits a locally
// started worker whose *_UPSTREAM env points at a node:http mock. Serial to avoid
// shared-capture-state and port races.
export default defineConfig({
	test: {
		include: ["test/sdk-compat/**/*.test.ts"],
		pool: "forks",
		fileParallelism: false, // serial: each file owns a mock upstream + worker on its own port
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
