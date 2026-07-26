import { env as testEnv } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index.js";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("worker import (spike)", () => {
  it("imports the default export from src/index.ts", () => {
    expect(worker).toBeDefined();
    expect(typeof worker.fetch).toBe("function");
  });

  it("fails closed with 503 when OAUTH_STATE_SECRET is unset on a sign-in route", async () => {
    const env: Env = { ...(testEnv as Env), OAUTH_STATE_SECRET: undefined as unknown as string };
    const request = new IncomingRequest("https://charter-gateway.example.com/authorize");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
  });
});
