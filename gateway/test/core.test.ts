import { describe, expect, it } from "vitest";
import { callCore, credHeaders, type CoreConfig } from "../src/core.js";

const CFG: CoreConfig = {
  url: "https://core.example.com",
  credential: "cfid:cfsecret:apikey",
};

/** Minimal fetch double: records the request, returns a canned response. */
function fakeFetch(status: number, body: string) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("credHeaders", () => {
  it("splits the three-part credential, keeping colons in the api key", () => {
    expect(credHeaders("cfid:cfsecret:api:key:with:colons")).toEqual({
      "X-API-Key": "api:key:with:colons",
      "CF-Access-Client-Id": "cfid",
      "CF-Access-Client-Secret": "cfsecret",
    });
  });

  it("treats a colon-free credential as a bare api key", () => {
    expect(credHeaders("justakey")).toEqual({
      "X-API-Key": "justakey",
      "CF-Access-Client-Id": "",
      "CF-Access-Client-Secret": "",
    });
  });

  it("yields an empty api key for a malformed two-part credential", () => {
    // Fails loudly at core (401) rather than silently sending half a credential.
    expect(credHeaders("cfid:cfsecret")["X-API-Key"]).toBe("");
  });
});

describe("callCore", () => {
  it("posts {...args, verb} and returns the body on 200", async () => {
    const { impl, seen } = fakeFetch(200, '{"ok":true}');
    const r = await callCore(impl, CFG, "verbs.list", { limit: 5 }, {});
    expect(r).toEqual({ text: '{"ok":true}', isError: false });
    expect(seen[0].url).toBe("https://core.example.com");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      limit: 5,
      verb: "verbs.list",
    });
  });

  it("adds read_only for a read-only call", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await callCore(impl, CFG, "data.warehouse.query", {}, { readOnly: true });
    expect(JSON.parse(String(seen[0].init.body)).read_only).toBe(true);
  });

  it("sends the credential and actor token as headers", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await callCore(impl, CFG, "verbs.list", {}, { actorToken: "idtok" });
    const h = seen[0].init.headers as Record<string, string>;
    expect(h["X-API-Key"]).toBe("apikey");
    expect(h["CF-Access-Client-Id"]).toBe("cfid");
    expect(h["X-Actor-Token"]).toBe("idtok");
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("omits X-Actor-Token entirely when there is no actor", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await callCore(impl, CFG, "verbs.list", {}, {});
    expect("X-Actor-Token" in (seen[0].init.headers as object)).toBe(false);
  });

  it("reports a non-2xx as an error carrying status and body", async () => {
    const { impl } = fakeFetch(403, '{"ok":false,"error":"denied"}');
    const r = await callCore(impl, CFG, "content.publish", {}, {});
    expect(r.isError).toBe(true);
    expect(r.text).toBe('HTTP 403: {"ok":false,"error":"denied"}');
  });

  it("rejects a missing verb without making a request", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    const r = await callCore(impl, CFG, "", {}, {});
    expect(r).toEqual({ text: "missing 'verb'", isError: true });
    expect(seen).toHaveLength(0);
  });

  it("refuses a non-https core url without making a request", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    const r = await callCore(
      impl,
      { ...CFG, url: "http://core.example.com" },
      "verbs.list",
      {},
      {},
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cleartext/);
    expect(seen).toHaveLength(0);
  });

  it("truncates a response larger than the inline cap", async () => {
    const big = "x".repeat(1024 * 1024 + 10);
    const { impl } = fakeFetch(200, big);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeLessThan(big.length);
    expect(r.text.endsWith("\n...[truncated]")).toBe(true);
  });

  const CAP_BYTES = 1024 * 1024;

  it("truncates a response whose byte length exceeds the cap, staying within it in bytes", async () => {
    const big = "x".repeat(CAP_BYTES + 10);
    const { impl } = fakeFetch(200, big);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(false);
    expect(r.text.endsWith("\n...[truncated]")).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(CAP_BYTES);
  });

  it("caps a multi-byte UTF-8 body by bytes, not characters, without throwing", async () => {
    // Each "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit — a char-length cap
    // would let a body like this run to ~2x the byte cap before truncating.
    const big = "é".repeat(CAP_BYTES);
    const { impl } = fakeFetch(200, big);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(false);
    expect(r.text.endsWith("\n...[truncated]")).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(CAP_BYTES);
    // At most the final cut character decodes to a replacement char — no mess.
    expect((r.text.match(/�/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("does not truncate a body exactly at the cap", async () => {
    const exact = "x".repeat(CAP_BYTES);
    const { impl } = fakeFetch(200, exact);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r).toEqual({ text: exact, isError: false });
  });

  it("handles an empty body", async () => {
    const { impl } = fakeFetch(200, "");
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r).toEqual({ text: "", isError: false });
  });

  it("returns an error, not a throw, when the network fails", async () => {
    const impl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(true);
    expect(r.text).toBe("request failed: connection reset");
  });

  it("never leaks the credential into an error message", async () => {
    const impl = (async () => {
      throw new Error("boom cfid:cfsecret:apikey");
    }) as unknown as typeof fetch;
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.text).not.toContain("apikey");
    expect(r.text).not.toContain("cfsecret");
  });
});
