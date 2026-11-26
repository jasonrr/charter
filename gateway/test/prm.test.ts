import { describe, expect, it } from "vitest";
import {
  MCP_PATH,
  protectedResourceMetadata,
  protectedResourceOf,
  resourceMetadataUrl,
} from "../src/prm.js";

const ORIGIN = "https://charter.example.com";

describe("protectedResourceOf", () => {
  // Only the /mcp document is served: 1.x binds every token to <origin>/mcp, so a document naming the bare origin would hand clients a resource the server refuses.
  it("recognises the path-suffixed well-known path", () => {
    expect(protectedResourceOf("/.well-known/oauth-protected-resource/mcp")).toBe(
      MCP_PATH,
    );
  });

  it("claims nothing else", () => {
    for (const p of [
      "/",
      "/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/other",
      "/.well-known/oauth-protected-resource/mcp/",
    ]) {
      expect(protectedResourceOf(p)).toBeNull();
    }
  });
});

describe("protectedResourceMetadata", () => {
  it("describes the resource the requested path identifies", () => {
    expect(protectedResourceMetadata(ORIGIN, MCP_PATH).resource).toBe(
      `${ORIGIN}/mcp`,
    );
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
