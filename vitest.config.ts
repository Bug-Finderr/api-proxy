import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tier 1: proxy logic, run inside workerd via the cloudflareTest plugin.
// Mocks outbound fetch; seeds KV directly. The fake bindings stand in for real keys/secrets.
// No rate-limit bindings here (RATE_LIMITER / LOGIN_LIMITER): limiter tests inject a fake via
// env spread; requests without one exercise the documented fail-open path.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/sdk-compat/**", "node_modules/**"],
  },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2025-01-01",
        kvNamespaces: ["TOKENS"],
        durableObjects: {
          US_EGRESS: { className: "UsEgress", useSQLite: true },
        },
        bindings: {
          // FAKE real-keys for tests. Real keys live in .env / CF secrets, never here.
          OPENAI_API_KEY: "real-openai-key-FAKE",
          ANTHROPIC_API_KEY: "real-anthropic-key-FAKE",
          GEMINI_API_KEY: "real-gemini-key-FAKE",
          ADMIN_SECRET: "test-admin-secret",
        },
      },
    }),
  ],
});
