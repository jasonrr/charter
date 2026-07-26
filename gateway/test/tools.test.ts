import { describe, expect, it } from "vitest";
import {
  handleTool,
  TOOL_CALL_NAME,
  TOOL_INPUT_SHAPE,
  TOOL_READ_NAME,
} from "../src/tools.js";
import type { CoreConfig } from "../src/core.js";

const CFG: CoreConfig = { url: "https://core.example.com", credential: "k" };

function fakeFetch(status: number, body: string) {
  const seen: { body: string; headers: Record<string, string> }[] = [];
  const impl = (async (_url: any, init: any) => {
    seen.push({
      body: String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("tool input shape", () => {
  it("accepts a verb with optional args and rejects a missing verb", () => {
    const schema = TOOL_INPUT_SHAPE;
    expect(schema.verb.safeParse("verbs.list").success).toBe(true);
    expect(schema.verb.safeParse(undefined).success).toBe(false);
    expect(schema.args.safeParse(undefined).success).toBe(true);
    expect(schema.args.safeParse({ a: 1 }).success).toBe(true);
  });
});

describe("handleTool", () => {
  it("routes charter_call as a write-capable call", async () => {
    const { impl, seen } = fakeFetch(200, '{"ok":true}');
    const r = await handleTool(impl, CFG, TOOL_CALL_NAME, { verb: "content.publish" }, "tok");
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toBe('{"ok":true}');
    expect(JSON.parse(seen[0].body).read_only).toBeUndefined();
  });

  it("routes charter_read as read-only", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await handleTool(impl, CFG, TOOL_READ_NAME, { verb: "data.warehouse.query" }, "tok");
    expect(JSON.parse(seen[0].body).read_only).toBe(true);
  });

  it("passes the actor token through to core", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await handleTool(impl, CFG, TOOL_READ_NAME, { verb: "verbs.list" }, "idtok");
    expect(seen[0].headers["X-Actor-Token"]).toBe("idtok");
  });

  it("spreads args into the request body alongside the verb", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await handleTool(impl, CFG, TOOL_CALL_NAME, { verb: "v", args: { x: 1 } }, "t");
    expect(JSON.parse(seen[0].body)).toEqual({ x: 1, verb: "v" });
  });

  it("defaults missing args to an empty object", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await handleTool(impl, CFG, TOOL_CALL_NAME, { verb: "v" }, "t");
    expect(JSON.parse(seen[0].body)).toEqual({ verb: "v" });
  });

  it("marks a core error as an MCP tool error", async () => {
    const { impl } = fakeFetch(403, '{"ok":false,"error":"denied"}');
    const r = await handleTool(impl, CFG, TOOL_CALL_NAME, { verb: "content.publish" }, "t");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("denied");
  });

  it("returns an error for an unknown tool name rather than throwing", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    const r = await handleTool(impl, CFG, "charter_login", { verb: "v" }, "t");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/i);
    expect(seen).toHaveLength(0);
  });
});
