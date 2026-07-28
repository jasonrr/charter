/**
 * Which paths `missingConfig` gates before they run — see index.ts's
 * `authHandler`.
 *
 * Kept here as data rather than inline in the handler's `if`, so a route
 * added to the sign-in flow without being added to this set fails a test
 * instead of reaching a caller as a bare 500 — which is exactly what happened
 * to `/authorize/continue`: it reads `OAUTH_STATE_SECRET` through
 * `importStateKey` just like `/authorize` and `/callback` do, but was missing
 * from the gate, so an unset secret reached `crypto.subtle.importKey` with a
 * zero-length key instead of the named 503 the other two routes return.
 */
const AUTH_ROUTE_PATHS = new Set(["/authorize", "/authorize/continue", "/callback"]);

export function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTE_PATHS.has(pathname);
}

/**
 * The connect routes (connect.ts) read `OAUTH_STATE_SECRET` too, and have the
 * same hazard. They are deliberately NOT listed here: their membership is
 * derived by `parseConnectPath`, so unlike this hand-maintained set it cannot
 * go stale, and index.ts already holds that result. A predicate here would only
 * re-run the same regex — and would invert the layering, since this module is a
 * dependency-free leaf.
 */
