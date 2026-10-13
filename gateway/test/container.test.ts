import { describe, it, expect } from "vitest";
import { coreEnv, coreFetch, instanceName, CORE_URL } from "../src/container";

describe("coreEnv", () => {
  it("strips CORE_ and adds the fixed trio, ignoring bindings and other vars", () => {
    const env = { CORE_CHARTER_KEYS: "{}", CORE_PACKS: "charter", GOOGLE_CLIENT_SECRET: "s", OAUTH_KV: {} };
    expect(coreEnv(env, "cid")).toEqual({
      CHARTER_KEYS: "{}", PACKS: "charter", PORT: "8080", CHARTER_BACKEND: "cloudflare", GOOGLE_OAUTH_CLIENT_ID: "cid",
    });
  });
});

describe("instanceName", () => {
  it("is stable across key order and changes with any value", async () => {
    const a = await instanceName({ A: "1", B: "2" });
    expect(await instanceName({ B: "2", A: "1" })).toBe(a);
    expect(await instanceName({ A: "1", B: "3" })).not.toBe(a);
    expect(a).toMatch(/^core-[0-9a-f]{16}$/);
  });
});

describe("coreFetch", () => {
  it("returns global fetch when no binding", async () => {
    expect(await coreFetch({ GOOGLE_CLIENT_ID: "cid" })).toBe(fetch);
  });
  it("routes to the env-named instance and forwards method, path, headers, body", async () => {
    let seen: Request | undefined; let vars: Record<string, string> | undefined; const names: string[] = [];
    const ns = { getByName: (n: string) => { names.push(n); return { fetchWithEnv: async (r: Request, v: Record<string, string>) => { seen = r; vars = v; return new Response("ok"); } }; } } as any;
    const f = await coreFetch({ CHARTER_CORE: ns, GOOGLE_CLIENT_ID: "cid", CORE_X: "1" } as any);
    const res = await f(CORE_URL, { method: "POST", headers: { "X-API-Key": "k" }, body: "{}" });
    expect(await res.text()).toBe("ok");
    expect(names[0]).toMatch(/^core-[0-9a-f]{16}$/);
    expect(seen!.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/");
    expect(seen!.headers.get("X-API-Key")).toBe("k");
    expect(await seen!.text()).toBe("{}");
    // The container starts with the env this Worker hashed into the name, never
    // the DO's own env, which can lag a deploy.
    expect(vars).toEqual(coreEnv({ CORE_X: "1" }, "cid"));
    expect(names[0]).toBe(await instanceName(vars!));
  });
});
