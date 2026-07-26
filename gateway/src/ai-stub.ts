/**
 * Build shim for the Vercel AI SDK, which this Worker does not use.
 *
 * `agents/mcp` pulls in the agents client chunk, and that chunk contains
 * `await import("ai")` inside MCPClientManager.ensureJsonSchema() — a helper
 * that exists to turn a *consumed* MCP server's tools into AI SDK tool
 * definitions. charter-gateway is the MCP server, not a client of one, so
 * nothing here can reach that call. But `ai` is an optional peer dependency of
 * `agents` and we have not installed it, and esbuild resolves dynamic imports
 * at bundle time, so the unreachable import fails the build anyway.
 *
 * wrangler.jsonc aliases "ai" here to satisfy the bundler. Installing the real
 * package instead would add a large dependency to a Worker bundle purely to
 * satisfy dead code.
 *
 * jsonSchema throws rather than returning a stub value: if a future change ever
 * does reach this path, it should fail loudly here instead of handing the
 * agents runtime something that silently is not a schema converter.
 */
export function jsonSchema(): never {
  throw new Error(
    "the 'ai' package is not installed in charter-gateway; " +
      "see src/ai-stub.ts if a code path now needs it",
  );
}
