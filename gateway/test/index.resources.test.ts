import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";

const ENV = {
  CHARTER_CORE_URL: "https://core.example.com",
  CF_ACCESS_CLIENT_ID: "cf-id",
  CF_ACCESS_CLIENT_SECRET: "cf-secret",
} as never; // only the fields coreConfig() reads

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = buildServer(ENV, "actor-token");
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe("CHARTER_INSTRUCTIONS", () => {
  it("sends deployment instructions at initialize, and none when unset", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await buildServer({ ...(ENV as object), CHARTER_INSTRUCTIONS: "use x.y" } as never, "t").connect(serverT);
    await client.connect(clientT);
    expect(client.getInstructions()).toBe("use x.y");
    expect((await connect()).getInstructions()).toBeUndefined();
  });
});
