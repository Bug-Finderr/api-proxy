/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from "../src/types";

// `env` from cloudflare:workers is typed as Cloudflare.Env; make it carry our bindings.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
