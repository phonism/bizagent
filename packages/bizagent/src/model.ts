// ModelResolver — the narrow SPI that turns a LOGICAL model key (what a caller asks for, e.g.
// "opus") into the CONCRETE config the SDK needs: the real model id (which differs per backend —
// an in-house gateway namespaces ids differently from the official API), plus an optional backend
// binary + env. bizagent ships only the contract and an identity default; the APP owns the
// registry (key -> id-per-backend, which backend a key forces, per-model defaults).
//
// Why separate from resolveAuth: resolveAuth is per-USER (who is calling — credentials, the
// default binary); resolveModel is per-MODEL (which backend the chosen model runs on). When both
// touch the binary/env, the model-level result wins — it's the more specific decision, so the
// SessionManager merges it AFTER authOptions.

import type { Identity } from "./session";
import type { Scope } from "./scope";

export interface ModelContext {
  identity?: Identity;
  scope?: Scope;
}

export interface ResolvedModel {
  /** Concrete id for the SDK `model` option (backend-specific). */
  model: string;
  /** Backend binary, when the chosen model runs on a non-default claude executable. Overrides
   *  the auth/default executable for this session. */
  claudeExecutable?: string;
  /** Extra env for this model/backend, merged over the session's auth env. */
  env?: Record<string, string>;
}

/** Resolve a logical model key into concrete SDK config. Sync or async (a registry lookup or a
 *  remote config fetch). */
export type ModelResolver = (key: string, ctx?: ModelContext) => ResolvedModel | Promise<ResolvedModel>;

/** The default: pass the key straight through as the model id, no backend override. This is the
 *  pre-existing behavior (SessionManager forwarded `model` verbatim) — a single-backend caller
 *  needs nothing more. */
export const identityModelResolver: ModelResolver = (key) => ({ model: key });
