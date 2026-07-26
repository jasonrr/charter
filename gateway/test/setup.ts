/**
 * @cloudflare/workers-oauth-provider (>=0.8) warns at module scope when the
 * CIMD compatibility flag is absent. That is legal in production workerd, but
 * fatal under the vitest pool, whose patched stdout does timer work that
 * workerd forbids in global scope — so every test file importing src/index.ts
 * would die at import. Swallow that one message before the worker module
 * evaluates. CIMD stays deliberately disabled: enabling it changes the client
 * registration surface that redirect_uri.ts's screening analysis covers.
 */
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("CIMD")) return;
  realWarn(...args);
};
