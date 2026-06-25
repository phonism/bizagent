// Notifier — the narrow SPI for pushing a message to a person/channel out of band (a scheduled
// run finished, a wakeup chain hit its cap, an anomaly fired). bizagent ships only the contract
// + a no-op default; the APP implements the transport (an internal IM gateway, a webhook, email).
// It earns its place now that the scheduler has a real trigger point — before scheduling there
// was no caller, so building it earlier would have been a speculative interface.
//
// Recipients are opaque ids (usernames, channel handles, addresses) the app interprets; bizagent
// never resolves them. `scopeKey` carries the origin scope so the app can route/attribute.

import type { Scope } from "./scope";
import { scopeKey as keyOf } from "./scope";

export interface Notification {
  /** Opaque recipient ids — the app maps these to real destinations. */
  to: string[];
  /** Message body (markdown allowed). */
  body: string;
  title?: string;
  /** Serialized origin scope, for the app to route/attribute. */
  scopeKey?: string;
  level?: "info" | "warn" | "critical";
}

/** Send a notification. Async; failures are the app's to handle (a notifier should not throw
 *  into a tick loop — wrap it if it might). */
export type Notifier = (n: Notification) => Promise<void>;

/** The default when no transport is configured: drop it. Keeps callers unconditional (they can
 *  always call notify) without bizagent inventing a destination. */
export const noopNotifier: Notifier = async () => {};

/** Convenience to stamp a Scope onto a notification without the caller touching scopeKey. */
export function withScope(n: Omit<Notification, "scopeKey">, scope?: Scope): Notification {
  return scope ? { ...n, scopeKey: keyOf(scope) } : n;
}
