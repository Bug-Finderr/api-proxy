import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tier 1 runs proxy logic in workerd with mocked upstreams and fake provider bindings.
// Limiter tests inject bindings; their absence exercises the fail-open path.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/sdk-compat/**"],
  },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-01", // keep in sync with wrangler.toml
        kvNamespaces: ["TOKENS"],
        durableObjects: {
          US_EGRESS: { className: "UsEgress", useSQLite: true },
          TOKEN_WRITER: { className: "TokenWriter", useSQLite: true },
        },
        bindings: {
          OPENAI_API_KEY: "real-openai-key-FAKE",
          ANTHROPIC_API_KEY: "real-anthropic-key-FAKE",
          GEMINI_API_KEY: "real-gemini-key-FAKE",
          ADMIN_SECRET: "test-admin-secret",
        },
      },
    }),
  ],
});
