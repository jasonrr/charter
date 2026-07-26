import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";

const ENV = {
  CHARTER_CORE_URL: "https://core.example.com",
  CF_ACCESS_CLIENT_ID: "cf-id",
  CF_ACCESS_CLIENT_SECRET: "cf-secret",
} as never; // only the fields coreConfig() reads

const ID = "A".repeat(32);

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = buildServer(ENV, "actor-token");
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe("charter://result/{id} resource", () => {
  it("reads an offloaded result end to end, carrying the actor token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", (async (url: unknown, init: unknown) => {
      seen.push({ url: String(url), init: init as RequestInit });
      return new Response(
        JSON.stringify({ ok: true, verb: "result.read", content: "BIGPAYLOAD" }),
        { status: 200 },
      );
    }) as typeof fetch);

    const client = await connect();
    const res = await client.readResource({ uri: `charter://result/${ID}` });
    expect(res.contents[0]).toMatchObject({
      uri: `charter://result/${ID}`,
      mimeType: "application/json",
      text: "BIGPAYLOAD",
    });
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ verb: "result.read", id: ID, read_only: true });
    expect((seen[0].init.headers as Record<string, string>)["X-Actor-Token"]).toBe("actor-token");
  });

  it("surfaces core's result_unknown as a resources/read error", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ ok: false, error: "result_unknown" }), { status: 404 })
    ) as typeof fetch);
    const client = await connect();
    await expect(client.readResource({ uri: `charter://result/${ID}` })).rejects.toThrow(/result_unknown/);
  });

  it("does not list the template's resources", async () => {
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 500 })) as typeof fetch);
    const client = await connect();
    const listed = await client.listResources();
    expect(listed.resources).toEqual([]);
  });
});
