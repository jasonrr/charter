import { env as testEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.js";

const ORIGIN = "https://charter-gateway.example.com"; // = wrangler.jsonc CHARTER_GATEWAY_URL

function fakeCore() {
  const seen: Request[] = [];
  const ns = { getByName: () => ({ fetchWithEnv: async (r: Request) => { seen.push(r); return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/problem+json", "Retry-After": "7" } }); } }) };
  return { ns: ns as unknown as Env["CHARTER_CORE"], seen };
}
function envWith(overrides: Partial<Env>): Env {
  return { ...(testEnv as Env), GOOGLE_CLIENT_ID: "test-google-client", GOOGLE_CLIENT_SECRET: "s",
           OAUTH_STATE_SECRET: "test-state-secret-0123456789", ...overrides };
}
async function call(env: Env, init: RequestInit, path = "/call"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as any, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /call", () => {
  it("401 without a key and never touches core", async () => {
    const { ns, seen } = fakeCore();
    const res = await call(envWith({ CHARTER_CORE: ns }), { method: "POST", body: "{}" });
    expect(res.status).toBe(401); expect(seen).toHaveLength(0);
  });
  it("forwards key, body and traceparent; never an actor token", async () => {
    const { ns, seen } = fakeCore();
    const res = await call(envWith({ CHARTER_CORE: ns }), { method: "POST", body: '{"verb":"verbs.list"}',
      headers: { "X-API-Key": "k1", "X-Actor-Token": "evil", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } });
    expect(res.status).toBe(200); expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("X-API-Key")).toBe("k1");
    expect(seen[0].headers.get("X-Actor-Token")).toBeNull();
    expect(seen[0].headers.get("traceparent")).toContain("0af7651916cd43dd");
    expect(await seen[0].text()).toBe('{"verb":"verbs.list"}');
  });
  it("405 on GET, 413 over 1 MiB, 502 when core throws", async () => {
    const { ns } = fakeCore();
    expect((await call(envWith({ CHARTER_CORE: ns }), { method: "GET" })).status).toBe(405);
    expect((await call(envWith({ CHARTER_CORE: ns }), { method: "POST", body: "{}", headers: { "X-API-Key": "k", "content-length": "2000000" } })).status).toBe(413);
    const boom = { getByName: () => ({ fetchWithEnv: async () => { throw new Error("no container"); } }) } as unknown as Env["CHARTER_CORE"];
    expect((await call(envWith({ CHARTER_CORE: boom }), { method: "POST", body: "{}", headers: { "X-API-Key": "k" } })).status).toBe(502);
  });
  it("413 on the actual body when there is no content-length (chunked)", async () => {
    const { ns, seen } = fakeCore();
    const big = new Uint8Array(1_048_577).fill(97);
    const body = new ReadableStream({ start(c) { c.enqueue(big); c.close(); } });
    const res = await call(envWith({ CHARTER_CORE: ns }), { method: "POST", body, duplex: "half", headers: { "X-API-Key": "k" } } as RequestInit);
    expect(res.status).toBe(413); expect(seen).toHaveLength(0);
  });
  it("404 without the binding (GCP mode unchanged)", async () => {
    expect((await call(envWith({ CHARTER_CORE: undefined }), { method: "POST", body: "{}", headers: { "X-API-Key": "k" } })).status).toBe(404);
  });
});
