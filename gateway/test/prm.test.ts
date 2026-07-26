import { describe, expect, it } from "vitest";
import {
  MCP_PATH,
  protectedResourceMetadata,
  protectedResourceOf,
  resourceMetadataUrl,
} from "../src/prm.js";

const ORIGIN = "https://charter.example.com";

describe("protectedResourceOf", () => {
  // The MCP spec has clients probe the path-suffixed form first and the bare
  // root second; both must answer, or discovery ends at "abort or use
  // pre-configured values".
  it("recognises both well-known paths the spec tells clients to probe", () => {
    expect(protectedResourceOf("/.well-known/oauth-protected-resource/mcp")).toBe(
      MCP_PATH,
    );
    expect(protectedResourceOf("/.well-known/oauth-protected-resource")).toBe("");
  });

  it("claims nothing else", () => {
    for (const p of [
      "/",
      "/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/other",
      "/.well-known/oauth-protected-resource/mcp/",
    ]) {
      expect(protectedResourceOf(p)).toBeNull();
    }
  });
});

describe("protectedResourceMetadata", () => {
  // RFC 9728 clients check `resource` against the URL they derived the
  // document from, so each path has to describe the resource its own URL
  // identifies rather than both returning the same one.
  it("describes the resource the requested path identifies", () => {
    expect(protectedResourceMetadata(ORIGIN, MCP_PATH).resource).toBe(
      `${ORIGIN}/mcp`,
    );
    expect(protectedResourceMetadata(ORIGIN, "").resource).toBe(ORIGIN);
  });

  it("names at least one authorization server, as the spec requires", () => {
    const doc = protectedResourceMetadata(ORIGIN, MCP_PATH);
    expect(doc.authorization_servers).toEqual([ORIGIN]);
  });
});

describe("resourceMetadataUrl", () => {
  it("points a 401 at the path-suffixed document", () => {
    expect(resourceMetadataUrl(ORIGIN)).toBe(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
  });
});
