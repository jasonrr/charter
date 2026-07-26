import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../src/core.js";
import { parseResultRef, readResult, RESULT_FETCH_MAX_BYTES, RESULT_URI_PREFIX } from "../src/results.js";

const cfg = (): CoreConfig => ({
  url: "https://core.example.com",
  cfAccessClientId: "cf-id",
  cfAccessClientSecret: "cf-secret",
});

function fakeFetch(status: number, body: string) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, seen };
}

const ID = "A".repeat(32);

describe("parseResultRef", () => {
  it("accepts core's offload envelope", () => {
    const text = JSON.stringify({ ok: true, verb: "v", request_id: "r",
      result_ref: { id: ID, bytes: 500000, mime: "application/json" } });
    expect(parseResultRef(text)).toEqual({ id: ID, bytes: 500000, mime: "application/json" });
  });

  it.each([
    ["not json", "{{nope"],
    ["no ref field", JSON.stringify({ ok: true })],
    ["ref not an object", JSON.stringify({ result_ref: "x" })],
    ["malformed id", JSON.stringify({ result_ref: { id: "../up", bytes: 1, mime: "m" } })],
    ["missing id", JSON.stringify({ result_ref: { bytes: 1, mime: "m" } })],
  ])("rejects %s", (_name, text) => {
    expect(parseResultRef(text)).toBeNull();
  });
});

describe("readResult", () => {
  it("calls result.read with the actor token, read_only, and the big cap", async () => {
    const { impl, seen } = fakeFetch(200, JSON.stringify({ ok: true, verb: "result.read", content: "PAYLOAD" }));
    const r = await readResult(impl, cfg(), ID, "actor-token");
    expect(r).toEqual({ text: "PAYLOAD", isError: false });
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ verb: "result.read", id: ID, read_only: true });
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers["X-Actor-Token"]).toBe("actor-token");
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("rejects a malformed id without calling core", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    const r = await readResult(impl, cfg(), "../nope", "t");
    expect(r.isError).toBe(true);
    expect(seen.length).toBe(0);
  });

  it("passes through a core error (e.g. result_unknown)", async () => {
    const { impl } = fakeFetch(404, JSON.stringify({ ok: false, error: "result_unknown" }));
    const r = await readResult(impl, cfg(), ID, "t");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("result_unknown");
  });

  it("errors on a 2xx whose content field is missing or not a string", async () => {
    const { impl } = fakeFetch(200, JSON.stringify({ ok: true }));
    const r = await readResult(impl, cfg(), ID, "t");
    expect(r.isError).toBe(true);
  });
});

it("RESULT_FETCH_MAX_BYTES is 16 MiB and the prefix is the charter scheme", () => {
  expect(RESULT_FETCH_MAX_BYTES).toBe(16 << 20);
  expect(RESULT_URI_PREFIX).toBe("charter://result/");
});
