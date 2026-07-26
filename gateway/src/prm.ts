/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint.
 *
 * The gateway is an MCP resource server, and the MCP authorization spec is
 * unambiguous about what that obliges it to publish. From
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 * (the current revision) and, word for word, from the 2026-07-28 revision at
 * .../draft/basic/authorization/authorization-server-discovery:
 *
 *   "MCP servers MUST implement OAuth 2.0 Protected Resource Metadata
 *    (RFC9728). MCP clients MUST use OAuth 2.0 Protected Resource Metadata for
 *    authorization server discovery."
 *
 *   "MCP servers MUST implement one of the following discovery mechanisms ...
 *    1. WWW-Authenticate Header: Include the resource metadata URL in the
 *    WWW-Authenticate HTTP header under `resource_metadata` when returning
 *    401 Unauthorized responses ... 2. Well-Known URI: Serve metadata at a
 *    well-known URI as specified in RFC9728."
 *
 * The gateway did neither: nothing served either well-known path (the
 * catch-all answered 200 "charter-gateway" for both, which a client cannot
 * parse), and no 401 carried `resource_metadata`. A client's only remaining
 * move is the one the spec's own sequence diagram names — "Abort or use
 * pre-configured values" — because the fallback to
 * `/.well-known/oauth-authorization-server` is built from the issuer inside
 * the PRM document, not from the resource's origin, so it is unreachable
 * without PRM. This module implements both mechanisms.
 *
 * The origin is the *configured* one (gateway_url.ts), not the request's Host,
 * for the same reason registration screening is: what the gateway says it is
 * must not be steerable by whoever asks.
 */

/** The MCP endpoint's path — OAuthProvider's `apiRoute` in index.ts. */
export const MCP_PATH = "/mcp";

const PRM_ROOT = "/.well-known/oauth-protected-resource";

/**
 * RFC 9728 §3.1 inserts the well-known segment before the resource's path, so
 * `https://gw/mcp` is described at `https://gw/.well-known/oauth-protected-resource/mcp`.
 * The MCP spec has clients probe that path-suffixed form first and the bare
 * root second, so both are served — each describing the resource its own URL
 * identifies, since a client that derived the URL will check `resource` against it.
 */
export function protectedResourceOf(pathname: string): string | null {
  if (pathname === `${PRM_ROOT}${MCP_PATH}`) return MCP_PATH;
  if (pathname === PRM_ROOT) return "";
  return null;
}

/** The `resource_metadata` URL to advertise on a 401 from the MCP endpoint. */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}${PRM_ROOT}${MCP_PATH}`;
}

/**
 * The metadata document for one of the two served paths.
 *
 * `authorization_servers` is the gateway itself: it is its own authorization
 * server for MCP clients (Google is federated behind it, and clients never
 * talk to Google directly). The spec requires this field to carry at least one
 * entry.
 */
export function protectedResourceMetadata(
  origin: string,
  resourcePath: string,
): Record<string, unknown> {
  return {
    resource: `${origin}${resourcePath}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  };
}
