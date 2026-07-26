# Charter Gateway (sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `charter-gateway` — a Cloudflare Worker that serves charter as a remote MCP server over Streamable HTTP, authenticates humans with OAuth federating Google, and translates `tools/call` into charter-core's `{"verb", ...args}` HTTP contract.

**Architecture:** Three pure, dependency-free modules (`core.ts` translation, `google.ts` federation, `tools.ts` MCP surface) that take their I/O as parameters and are unit-testable with plain vitest, plus one thin wiring module (`index.ts`) that composes them with `OAuthProvider` (from `workers-oauth-provider`) and `createMcpHandler` (from `agents/mcp`). The gateway is stateless — no Durable Object — and holds two secrets: the core credential and the Google client secret. Core is unchanged by this sub-project except for one config value (§4.6).

**Tech Stack:** TypeScript, Cloudflare Workers, `wrangler`, `agents` (`createMcpHandler`, `getMcpAuthContext`), `workers-oauth-provider` (`OAuthProvider`), `@modelcontextprotocol/sdk` (`McpServer`), `zod`, `vitest`.

This is sub-project B of `docs/remote-mcp.md`. Sub-project A (**grants**) landed 2026-07-25 — core already derives a caller from `X-Actor-Token` + grants, which is the seam this gateway plugs into. Nothing here changes core's authorization logic.

## Global Constraints

- **The gateway is non-authoritative (§2.1).** It makes no authorization decision and writes no audit row. It forwards a Google ID token; **core verifies it**. Never add a scope/permission check to gateway code — if you find yourself writing one, it belongs in core's grants.
- **No token passthrough (§4.3).** The MCP access token the gateway issues to the client is *never* forwarded upstream. Calls to core use the gateway's own held credential. These are two different credentials and must never be conflated.
- **Core's contract is unchanged.** POST the core URL with body `{...args, "verb": <verb>}` plus `{"read_only": true}` for read-only calls. Do not invent new fields, headers, or endpoints.
- **Secrets never appear in logs, error messages, or tool results.** Error text returned to the model must never include a credential, a Google client secret, an access token, or an ID token.
- **Stateless.** `createMcpHandler` in a plain Worker; no Durable Object, no `McpAgent`. Construct a fresh `McpServer` per request — the MCP SDK (≥1.26.0) rejects reconnecting an already-connected server.
- **Dual-era is the SDK's job (§5).** Do not hand-roll protocol negotiation, `server/discover`, routable-header validation, or session handling. Whatever revision the installed SDK speaks is what the gateway ships; both directions negotiate automatically.
- Node 20+, TypeScript strict mode. Keep dependencies to the four named above plus `vitest`/`wrangler` as dev dependencies.
- Match charter's commenting style: a module docstring at the top of each file explaining the *why*, and `ponytail:` comments on deliberate shortcuts.

## File Structure

All new code lives in a new top-level `gateway/` directory. It is a separate npm project from the Python core — they share a repo, not a build.

| File | Responsibility |
|---|---|
| `gateway/src/core.ts` | Translate a verb call into an HTTP request to core and normalize the response. Takes `fetch` as a parameter — no global I/O, fully unit-testable. |
| `gateway/src/google.ts` | Google federation: build the authorize URL, exchange the code, and keep a fresh ID token from a stored refresh token (§4.6). Takes `fetch` as a parameter. |
| `gateway/src/tools.ts` | The MCP surface: the two tool definitions and the handler that routes them into `core.ts`. |
| `gateway/src/index.ts` | Wiring only: `OAuthProvider` + `createMcpHandler`, the Google auth handler routes, and the `Env` type. No business logic. |
| `gateway/test/*.test.ts` | Unit tests for the three pure modules. |
| `gateway/wrangler.jsonc` | Worker config: name, compatibility date, vars, KV binding for OAuth storage. |
| `docs/deployment/gateway.md` | Operator runbook: Google client setup, secrets, deploy, verification. |

---

### Task 1: Project scaffold and the core client

**Files:**
- Create: `gateway/package.json`, `gateway/tsconfig.json`, `gateway/wrangler.jsonc`, `gateway/.gitignore`
- Create: `gateway/src/core.ts`
- Test: `gateway/test/core.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type CoreConfig = { url: string; credential: string; userAgent?: string }`
  - `type CoreResult = { text: string; isError: boolean }`
  - `credHeaders(credential: string) -> Record<string, string>`
  - `callCore(fetchImpl: typeof fetch, cfg: CoreConfig, verb: string, args: object, opts: { readOnly?: boolean; actorToken?: string }) -> Promise<CoreResult>`

- [ ] **Step 1: Create the project scaffold**

`gateway/package.json`:

```json
{
  "name": "charter-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "deploy": "wrangler deploy",
    "dev": "wrangler dev"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "agents": "^0.2.0",
    "workers-oauth-provider": "^0.0.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250109.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.100.0"
  }
}
```

Install with `cd gateway && npm install`, then **pin what actually resolved**: run `npm ls --depth=0` and replace each `^`-range above with the exact installed version. The published versions of `agents` and `workers-oauth-provider` move quickly; the plan's ranges are a floor, and the lockfile is the truth. If `npm install` fails to resolve any package, stop and report it — do not substitute a different library.

`gateway/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`gateway/.gitignore`:

```
node_modules/
.wrangler/
dist/
```

`gateway/wrangler.jsonc` — the KV namespace id is filled in by the operator in Task 5; leave the placeholder string exactly as written so Task 5's runbook can find it:

```jsonc
{
  "name": "charter-gateway",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }
  ],
  "vars": {
    "CHARTER_CORE_URL": "https://charter.example.com",
    "CHARTER_ALLOWED_DOMAIN": "@example.com",
    "GOOGLE_CLIENT_ID": ""
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `gateway/test/core.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd gateway && npx vitest run test/core.test.ts`
Expected: FAIL — cannot resolve `../src/core.js`.

- [ ] **Step 4: Write the implementation**

Create `gateway/src/core.ts`:

```ts
/**
 * Translation to charter-core.
 *
 * This is charter_mcp.js's callBridge(), minus the local-file tricks and minus
 * Node. One POST of {...args, verb} to core's single endpoint, with the
 * gateway-held credential and — when a human is signed in — their Google ID
 * token as X-Actor-Token. Core verifies that token itself and derives the
 * caller's scope from grants; the gateway decides nothing (spec §2.1).
 *
 * fetch is a parameter, not a global, so every branch here is unit-testable
 * without a Worker runtime or a network.
 */

/** 1 MB, matching the stdio proxy's cap on what may enter a model's context. */
const MAX_RESPONSE_BYTES = 1 << 20;

export type CoreConfig = {
  url: string;
  credential: string;
  userAgent?: string;
};

export type CoreResult = { text: string; isError: boolean };

/**
 * Split the one pasted credential into headers.
 *
 * "cf-client-id:cf-client-secret:api-key" is the composite form; CF ids and
 * secrets are colon-free, so any extra colons belong to the API key. A
 * colon-free value is a bare API key (non-Cloudflare deploys). A two-part value
 * is malformed and yields an empty key, which fails loudly at core with a 401 —
 * deliberately better than silently sending half a credential.
 */
export function credHeaders(credential: string): Record<string, string> {
  const cred = (credential || "").trim();
  const parts = cred.split(":");
  if (parts.length === 1) {
    return {
      "X-API-Key": parts[0],
      "CF-Access-Client-Id": "",
      "CF-Access-Client-Secret": "",
    };
  }
  const [id = "", secret = "", ...key] = parts;
  return {
    "X-API-Key": key.join(":"),
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret,
  };
}

/** Strip anything credential-shaped out of text bound for a model or a log. */
function scrub(text: string, cfg: CoreConfig): string {
  let out = text;
  for (const secret of [cfg.credential, ...cfg.credential.split(":")]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export async function callCore(
  fetchImpl: typeof fetch,
  cfg: CoreConfig,
  verb: string,
  args: object,
  opts: { readOnly?: boolean; actorToken?: string },
): Promise<CoreResult> {
  if (!verb) return { text: "missing 'verb'", isError: true };

  let u: URL;
  try {
    u = new URL(cfg.url);
  } catch (e) {
    return { text: `bad core url: ${(e as Error).message}`, isError: true };
  }
  if (u.protocol !== "https:") {
    return {
      text: "refusing to send credentials in cleartext; core url must be https://",
      isError: true,
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Explicit UA: Cloudflare 1010-bans default client signatures at the edge,
    // before CF Access runs. Any non-default UA passes.
    "User-Agent": cfg.userAgent ?? "charter-gateway/0.1",
    ...credHeaders(cfg.credential),
  };
  if (opts.actorToken) headers["X-Actor-Token"] = opts.actorToken;

  const payload = JSON.stringify({
    ...args,
    verb,
    ...(opts.readOnly ? { read_only: true } : {}),
  });

  let res: Response;
  try {
    res = await fetchImpl(u.toString(), {
      method: "POST",
      headers,
      body: payload,
    });
  } catch (e) {
    return {
      text: scrub(`request failed: ${(e as Error).message}`, cfg),
      isError: true,
    };
  }

  let text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    text = text.slice(0, MAX_RESPONSE_BYTES) + "\n...[truncated]";
  }
  if (res.status >= 200 && res.status < 300) {
    return { text, isError: false };
  }
  return { text: scrub(`HTTP ${res.status}: ${text}`, cfg), isError: true };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd gateway && npx vitest run test/core.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Typecheck**

Run: `cd gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add gateway/
git commit -m "feat(gateway): project scaffold + core translation client"
```

---

### Task 2: Google federation and a fresh actor token

**Files:**
- Create: `gateway/src/google.ts`
- Test: `gateway/test/google.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent module).
- Produces:
  - `type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string; allowedDomain: string }`
  - `type GoogleIdentity = { email: string; idToken: string; idTokenExp: number; refreshToken: string }`
  - `buildAuthorizeUrl(cfg: GoogleConfig, state: string) -> string`
  - `exchangeCode(fetchImpl: typeof fetch, cfg: GoogleConfig, code: string) -> Promise<GoogleIdentity>`
  - `freshIdToken(fetchImpl: typeof fetch, cfg: GoogleConfig, identity: GoogleIdentity, nowSeconds: number) -> Promise<{ idToken: string; identity: GoogleIdentity }>`
  - `decodeIdTokenClaims(idToken: string) -> { email?: string; email_verified?: boolean; exp?: number; aud?: string }`

**Why this module exists (§4.6):** core verifies the ID token's `aud` against its own configured Google client id, and Google ID tokens live about an hour while an MCP session outlives that. So the gateway asks Google for offline access, keeps the refresh token in the encrypted OAuth props, and re-mints the ID token when it is close to expiry. `decodeIdTokenClaims` reads the payload **without verifying it** — it is used only to find `exp` and to show the operator which account signed in. **Core does the verification that matters.** Never treat a claim decoded here as trusted.

- [ ] **Step 1: Write the failing test**

Create `gateway/test/google.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  decodeIdTokenClaims,
  exchangeCode,
  freshIdToken,
  type GoogleConfig,
  type GoogleIdentity,
} from "../src/google.js";

const CFG: GoogleConfig = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "csecret",
  redirectUri: "https://gw.example.com/callback",
  allowedDomain: "@example.com",
};

/** Build an unsigned JWT with the given payload — shape only, never verified here. */
function jwt(payload: object): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

function fakeFetch(bodies: object[]) {
  const seen: { url: string; body: string }[] = [];
  let i = 0;
  const impl = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(bodies[i++]), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("buildAuthorizeUrl", () => {
  it("requests openid email with offline access and forced consent", () => {
    const u = new URL(buildAuthorizeUrl(CFG, "st4te"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CFG.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("state")).toBe("st4te");
    // offline + consent are what make a refresh token arrive (§4.6 freshness).
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("hints the work domain so the account chooser defaults correctly", () => {
    const u = new URL(buildAuthorizeUrl(CFG, "s"));
    expect(u.searchParams.get("hd")).toBe("example.com");
  });
});

describe("decodeIdTokenClaims", () => {
  it("reads the payload segment", () => {
    const c = decodeIdTokenClaims(jwt({ email: "a@example.com", exp: 42 }));
    expect(c.email).toBe("a@example.com");
    expect(c.exp).toBe(42);
  });

  it("returns an empty object for a malformed token rather than throwing", () => {
    expect(decodeIdTokenClaims("not-a-jwt")).toEqual({});
    expect(decodeIdTokenClaims("")).toEqual({});
  });
});

describe("exchangeCode", () => {
  it("posts the code and returns the identity with its refresh token", async () => {
    const idToken = jwt({
      email: "jason@example.com",
      email_verified: true,
      exp: 1000,
    });
    const { impl, seen } = fakeFetch([
      { id_token: idToken, refresh_token: "r3fresh", expires_in: 3600 },
    ]);
    const got = await exchangeCode(impl, CFG, "thecode");
    expect(got.email).toBe("jason@example.com");
    expect(got.idToken).toBe(idToken);
    expect(got.idTokenExp).toBe(1000);
    expect(got.refreshToken).toBe("r3fresh");
    expect(seen[0].url).toBe("https://oauth2.googleapis.com/token");
    const sent = new URLSearchParams(seen[0].body);
    expect(sent.get("code")).toBe("thecode");
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("redirect_uri")).toBe(CFG.redirectUri);
  });

  it("rejects an account outside the allowed domain", async () => {
    const { impl } = fakeFetch([
      {
        id_token: jwt({ email: "x@other.com", email_verified: true, exp: 1000 }),
        refresh_token: "r",
        expires_in: 3600,
      },
    ]);
    await expect(exchangeCode(impl, CFG, "c")).rejects.toThrow(/example\.com/);
  });

  it("rejects an unverified email", async () => {
    const { impl } = fakeFetch([
      {
        id_token: jwt({ email: "x@example.com", email_verified: false, exp: 1000 }),
        refresh_token: "r",
        expires_in: 3600,
      },
    ]);
    await expect(exchangeCode(impl, CFG, "c")).rejects.toThrow(/verified/);
  });

  it("rejects a response with no refresh token", async () => {
    // Without one there is no way to stay fresh past an hour (§4.6).
    const { impl } = fakeFetch([
      {
        id_token: jwt({ email: "x@example.com", email_verified: true, exp: 1000 }),
        expires_in: 3600,
      },
    ]);
    await expect(exchangeCode(impl, CFG, "c")).rejects.toThrow(/refresh token/);
  });

  it("never puts the client secret in a thrown error", async () => {
    const impl = (async () =>
      new Response("upstream failure csecret", { status: 500 })) as unknown as typeof fetch;
    await expect(exchangeCode(impl, CFG, "c")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("csecret") }),
    );
  });
});

describe("freshIdToken", () => {
  const identity: GoogleIdentity = {
    email: "jason@example.com",
    idToken: jwt({ email: "jason@example.com", exp: 5000 }),
    idTokenExp: 5000,
    refreshToken: "r3fresh",
  };

  it("reuses the cached token while it is still valid", async () => {
    const { impl, seen } = fakeFetch([]);
    const got = await freshIdToken(impl, CFG, identity, 4000);
    expect(got.idToken).toBe(identity.idToken);
    expect(seen).toHaveLength(0);
  });

  it("re-mints when the token is within the refresh margin of expiry", async () => {
    const next = jwt({ email: "jason@example.com", exp: 9000 });
    const { impl, seen } = fakeFetch([{ id_token: next, expires_in: 3600 }]);
    const got = await freshIdToken(impl, CFG, identity, 4990);
    expect(got.idToken).toBe(next);
    expect(got.identity.idTokenExp).toBe(9000);
    // The refresh token is carried forward — Google need not return a new one.
    expect(got.identity.refreshToken).toBe("r3fresh");
    const sent = new URLSearchParams(seen[0].body);
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("r3fresh");
  });

  it("re-mints when the token is already expired", async () => {
    const next = jwt({ email: "jason@example.com", exp: 9000 });
    const { impl } = fakeFetch([{ id_token: next, expires_in: 3600 }]);
    const got = await freshIdToken(impl, CFG, identity, 6000);
    expect(got.idToken).toBe(next);
  });

  it("adopts a rotated refresh token when Google returns one", async () => {
    const next = jwt({ email: "jason@example.com", exp: 9000 });
    const { impl } = fakeFetch([
      { id_token: next, refresh_token: "rotated", expires_in: 3600 },
    ]);
    const got = await freshIdToken(impl, CFG, identity, 6000);
    expect(got.identity.refreshToken).toBe("rotated");
  });

  it("surfaces a revoked grant as an error naming re-authentication", async () => {
    const impl = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    await expect(freshIdToken(impl, CFG, identity, 6000)).rejects.toThrow(/sign in again/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gateway && npx vitest run test/google.test.ts`
Expected: FAIL — cannot resolve `../src/google.js`.

- [ ] **Step 3: Write the implementation**

Create `gateway/src/google.ts`:

```ts
/**
 * Google federation for the gateway.
 *
 * The gateway is its own OAuth authorization server for MCP clients, and a
 * *client* of Google for identity. This module owns only the Google half.
 *
 * Two things make it more than a code exchange (spec §4.6):
 *
 *  1. Audience. Core verifies the ID token against ITS configured Google client
 *     id, so the token must be minted for the gateway's Web client and core must
 *     be pointed at that same client id.
 *  2. Freshness. Google ID tokens live about an hour; an MCP session outlives
 *     that. So we ask for offline access, keep the refresh token in the OAuth
 *     props workers-oauth-provider already encrypts, and re-mint on demand.
 *
 * decodeIdTokenClaims does NOT verify anything — it reads `exp` and `email` for
 * scheduling and display. Core performs the verification that authorizes
 * anything at all (§2.1).
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Re-mint this many seconds before expiry so a call never races the clock. */
const REFRESH_MARGIN_SECONDS = 60;

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** e.g. "@example.com" — matched as a suffix, same rule as core's actor_auth. */
  allowedDomain: string;
};

export type GoogleIdentity = {
  email: string;
  idToken: string;
  idTokenExp: number;
  refreshToken: string;
};

type Claims = {
  email?: string;
  email_verified?: boolean;
  exp?: number;
  aud?: string;
};

export function decodeIdTokenClaims(idToken: string): Claims {
  try {
    const seg = idToken.split(".")[1];
    if (!seg) return {};
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(pad)) as Claims;
  } catch {
    return {}; // ponytail: an unreadable token is simply "no claims"; core rejects it anyway
  }
}

export function buildAuthorizeUrl(cfg: GoogleConfig, state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", state);
  // offline + consent are what cause a refresh_token to be issued at all.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("hd", cfg.allowedDomain.replace(/^@/, ""));
  return u.toString();
}

/** Redact the client secret from anything that might reach a log or a client. */
function safe(message: string, cfg: GoogleConfig): string {
  return cfg.clientSecret
    ? message.split(cfg.clientSecret).join("[redacted]")
    : message;
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  cfg: GoogleConfig,
  form: Record<string, string>,
): Promise<any> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(safe(`google token endpoint returned ${res.status}: ${text}`, cfg));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("google token endpoint returned a non-JSON response");
  }
}

export async function exchangeCode(
  fetchImpl: typeof fetch,
  cfg: GoogleConfig,
  code: string,
): Promise<GoogleIdentity> {
  const body = await tokenRequest(fetchImpl, cfg, {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });

  const idToken: string = body.id_token ?? "";
  const claims = decodeIdTokenClaims(idToken);
  const email = claims.email ?? "";

  if (!claims.email_verified) {
    throw new Error(
      `sign-in rejected: ${email || "that account"} is not a verified account`,
    );
  }
  if (!email.endsWith(cfg.allowedDomain)) {
    throw new Error(
      `sign-in rejected: charter requires a ${cfg.allowedDomain} account ` +
        `(got ${email || "no email"}); pick your work account`,
    );
  }
  if (!body.refresh_token) {
    // Without this the session dies at the one-hour mark with no way to recover.
    throw new Error(
      "google returned no refresh token; the gateway cannot keep the session " +
        "signed in. Revoke the app at myaccount.google.com and sign in again.",
    );
  }

  return {
    email,
    idToken,
    idTokenExp: claims.exp ?? 0,
    refreshToken: body.refresh_token,
  };
}

export async function freshIdToken(
  fetchImpl: typeof fetch,
  cfg: GoogleConfig,
  identity: GoogleIdentity,
  nowSeconds: number,
): Promise<{ idToken: string; identity: GoogleIdentity }> {
  if (identity.idTokenExp - REFRESH_MARGIN_SECONDS > nowSeconds) {
    return { idToken: identity.idToken, identity };
  }

  let body: any;
  try {
    body = await tokenRequest(fetchImpl, cfg, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: identity.refreshToken,
      grant_type: "refresh_token",
    });
  } catch (e) {
    throw new Error(
      "your Google sign-in is no longer valid — sign in again to charter " +
        `(${(e as Error).message})`,
    );
  }

  const idToken: string = body.id_token ?? "";
  const claims = decodeIdTokenClaims(idToken);
  return {
    idToken,
    identity: {
      ...identity,
      idToken,
      idTokenExp: claims.exp ?? 0,
      // Google usually omits refresh_token on refresh; adopt it only when rotated.
      refreshToken: body.refresh_token ?? identity.refreshToken,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gateway && npx vitest run test/google.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `cd gateway && npx tsc --noEmit`
Expected: no errors.

```bash
git add gateway/src/google.ts gateway/test/google.test.ts
git commit -m "feat(gateway): google federation with offline refresh for the actor token"
```

---

### Task 3: The MCP tool surface

**Files:**
- Create: `gateway/src/tools.ts`
- Test: `gateway/test/tools.test.ts`

**Interfaces:**
- Consumes: `callCore`, `CoreConfig`, `CoreResult` from `./core.js` (Task 1).
- Produces:
  - `const TOOL_READ_NAME = "charter_read"`, `const TOOL_CALL_NAME = "charter_call"`
  - `const TOOL_INPUT_SHAPE` — the zod shape both tools share.
  - `TOOL_READ_DESCRIPTION`, `TOOL_CALL_DESCRIPTION` (strings)
  - `handleTool(fetchImpl, cfg, toolName, args, actorToken) -> Promise<{ content: [{ type: "text"; text: string }]; isError: boolean }>`

**Surface decisions (§4.2, §4.6):** two tools, not four. `charter_login` is gone — OAuth at install replaces it. `charter_connect_hubspot` is **out of scope for B**: it opens a loopback listener on `127.0.0.1:53682`, which a remote gateway does not have; verbs needing a HubSpot identity keep returning `hs_identity_required` until that flow is re-hosted separately. `args_path` and `out_path` are gone too — they read and write the *client's* disk, which a remote server cannot reach (§4.5).

- [ ] **Step 1: Write the failing test**

Create `gateway/test/tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd gateway && npx vitest run test/tools.test.ts`
Expected: FAIL — cannot resolve `../src/tools.js`.

- [ ] **Step 3: Write the implementation**

Create `gateway/src/tools.ts`:

```ts
/**
 * The MCP surface: two tools over the whole verb catalog.
 *
 * Verb discovery stays on demand through `verbs.list` rather than being
 * expanded into one MCP tool per verb. That is the whole point of charter — a
 * client pays for two tool definitions, not fifty, and the catalog it sees is
 * already filtered to what its caller is allowed to run.
 *
 * Dropped from the stdio proxy's four tools:
 *  - charter_login: OAuth at install replaces it (§4.2).
 *  - charter_connect_hubspot: it opens a loopback listener on 127.0.0.1, which a
 *    remote gateway has no equivalent of. Out of scope for B (§4.6); verbs that
 *    need a HubSpot identity keep returning hs_identity_required.
 *  - args_path / out_path: they read and write the CLIENT's disk. A remote
 *    server cannot. Large payloads move by reference instead (§4.5).
 */
import { z } from "zod";
import { callCore, type CoreConfig } from "./core.js";

export const TOOL_READ_NAME = "charter_read";
export const TOOL_CALL_NAME = "charter_call";

export const TOOL_INPUT_SHAPE = {
  verb: z.string().describe("e.g. verbs.list or data.warehouse.query"),
  args: z.record(z.any()).optional().describe("verb arguments (default {})"),
};

export const TOOL_READ_DESCRIPTION =
  "READ-ONLY view of your data — use this (NOT charter_call) for ANY data " +
  "question. Safe to always-allow: the server rejects write verbs sent here " +
  "(returns write_in_read_tool). Call `verbs.list` first to discover available " +
  "verbs, then use read verbs like `data.warehouse.schema` / " +
  "`data.warehouse.query` or `data.posthog.schema` / `data.posthog.query` — each " +
  "has a schema verb that returns the table catalog plus an analyst guide with " +
  "dialect gotchas and business definitions. Unsure which resource? Call BOTH " +
  "`.schema` verbs — they're cheap and each guide cross-links the other. " +
  "To DRAFT or PUBLISH content, use charter_call instead.";

export const TOOL_CALL_DESCRIPTION =
  "Call a charter verb. Pass the verb name and its args; returns the engine's " +
  "JSON response verbatim. Authentication is added by this server — NEVER put " +
  "secrets in args. Call `verbs.list` first to discover exactly which verbs you " +
  "can use, each with a one-line summary and read/write flag (it's always " +
  "callable and shows only your verbs). On failure the result is the string " +
  "'HTTP <status>: {...\"error\":\"<code>\"...}' — match on the <code> " +
  "(e.g. denied = your account lacks scope for that verb; confirm_required = " +
  "pass confirm:true for irreversible verbs; hs_identity_required = your HubSpot " +
  "account isn't connected). Large inputs go by reference: pass an id or URI the " +
  "verb dereferences, never a large inline body.";

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError: boolean;
};

export async function handleTool(
  fetchImpl: typeof fetch,
  cfg: CoreConfig,
  toolName: string,
  args: { verb?: string; args?: Record<string, unknown> },
  actorToken: string,
): Promise<ToolResult> {
  if (toolName !== TOOL_READ_NAME && toolName !== TOOL_CALL_NAME) {
    return {
      content: [{ type: "text", text: `unknown tool: ${toolName}` }],
      isError: true,
    };
  }
  const { text, isError } = await callCore(
    fetchImpl,
    cfg,
    args.verb ?? "",
    args.args ?? {},
    { readOnly: toolName === TOOL_READ_NAME, actorToken },
  );
  return { content: [{ type: "text", text }], isError };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd gateway && npx vitest run test/tools.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `cd gateway && npx vitest run && npx tsc --noEmit`
Expected: PASS, all three test files (33 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/tools.ts gateway/test/tools.test.ts
git commit -m "feat(gateway): charter_read + charter_call MCP tool surface"
```

---

### Task 4: Wire the Worker — OAuth provider and MCP handler

**Files:**
- Create: `gateway/src/index.ts`
- Modify: `gateway/wrangler.jsonc` (no change needed if Task 1's version was written as specified — verify the KV binding is present)

**Interfaces:**
- Consumes: `callCore`/`CoreConfig` (Task 1), `exchangeCode`/`freshIdToken`/`buildAuthorizeUrl`/`GoogleConfig`/`GoogleIdentity` (Task 2), `handleTool`/`TOOL_*` (Task 3).
- Produces: the Worker's default export, and `type Env`.

This task is **wiring only** — no new business logic, so it carries no unit tests of its own. Its verification is a typecheck plus a local smoke run; the real proof is Task 5's end-to-end check against core.

**Read the library docs before writing this file.** The `OAuthProvider` and `createMcpHandler` APIs are the two pieces this plan cannot pin to an exact installed version:
- `https://developers.cloudflare.com/agents/model-context-protocol/authorization/`
- `https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/`

The code below matches those docs as of 2026-07-25. **If the installed version's API differs, follow the installed version and note the difference in your report** — do not force the plan's shape onto a different API.

- [ ] **Step 1: Write the Worker**

Create `gateway/src/index.ts`:

```ts
/**
 * charter-gateway: MCP over Streamable HTTP, OAuth in front, charter-core behind.
 *
 * Wiring only. The gateway holds two secrets — the core credential and the
 * Google client secret — so humans hold neither (§3). It decides nothing: the
 * caller's Google ID token rides to core as X-Actor-Token, and core derives
 * scope from grants and writes the audit row (§2.1).
 *
 * Stateless by construction: createMcpHandler in a plain Worker, a fresh
 * McpServer per request. No Durable Object — the gateway keeps no per-session
 * state of its own; the only state is the OAuth grant, which
 * workers-oauth-provider persists (encrypted) in KV.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import OAuthProvider from "workers-oauth-provider";

import { type CoreConfig } from "./core.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  freshIdToken,
  type GoogleConfig,
  type GoogleIdentity,
} from "./google.js";
import {
  handleTool,
  TOOL_CALL_DESCRIPTION,
  TOOL_CALL_NAME,
  TOOL_INPUT_SHAPE,
  TOOL_READ_DESCRIPTION,
  TOOL_READ_NAME,
} from "./tools.js";

export type Env = {
  OAUTH_KV: KVNamespace;
  CHARTER_CORE_URL: string;
  CHARTER_ALLOWED_DOMAIN: string;
  GOOGLE_CLIENT_ID: string;
  /** wrangler secret put CHARTER_CREDENTIAL */
  CHARTER_CREDENTIAL: string;
  /** wrangler secret put GOOGLE_CLIENT_SECRET */
  GOOGLE_CLIENT_SECRET: string;
};

/** What we persist per grant. workers-oauth-provider encrypts this at rest. */
type Props = { identity: GoogleIdentity };

function googleConfig(env: Env, requestUrl: string): GoogleConfig {
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL("/callback", requestUrl).toString(),
    allowedDomain: env.CHARTER_ALLOWED_DOMAIN,
  };
}

function coreConfig(env: Env): CoreConfig {
  return { url: env.CHARTER_CORE_URL, credential: env.CHARTER_CREDENTIAL };
}

// --- the MCP API handler -----------------------------------------------------

function buildServer(env: Env): McpServer {
  // A fresh server per request: the SDK (>=1.26.0) refuses to reconnect one.
  const server = new McpServer({ name: "charter", version: "0.1.0" });

  const run = async (
    toolName: string,
    args: { verb: string; args?: Record<string, unknown> },
  ) => {
    const auth = getMcpAuthContext();
    const props = auth?.props as Props | undefined;
    if (!props?.identity) {
      return {
        content: [{ type: "text" as const, text: "not signed in to charter" }],
        isError: true,
      };
    }
    // Re-mint the Google ID token if it is at or near expiry (§4.6).
    const { idToken } = await freshIdToken(
      fetch,
      googleConfig(env, env.CHARTER_CORE_URL),
      props.identity,
      Math.floor(Date.now() / 1000),
    );
    return handleTool(fetch, coreConfig(env), toolName, args, idToken);
  };

  server.tool(TOOL_READ_NAME, TOOL_READ_DESCRIPTION, TOOL_INPUT_SHAPE, (a: any) =>
    run(TOOL_READ_NAME, a),
  );
  server.tool(TOOL_CALL_NAME, TOOL_CALL_DESCRIPTION, TOOL_INPUT_SHAPE, (a: any) =>
    run(TOOL_CALL_NAME, a),
  );
  return server;
}

const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(buildServer(env), { route: "/mcp" })(request, env, ctx);
  },
};

// --- the sign-in handler (Google federation) ---------------------------------

const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      // workers-oauth-provider parsed the client's request; carry it as state so
      // /callback can complete the grant it belongs to.
      const oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(request);
      const state = btoa(JSON.stringify(oauthReq));
      return Response.redirect(buildAuthorizeUrl(googleConfig(env, request.url), state), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      let identity: GoogleIdentity;
      try {
        identity = await exchangeCode(fetch, googleConfig(env, request.url), code);
      } catch (e) {
        // Safe to show: google.ts redacts the client secret before throwing.
        return new Response((e as Error).message, { status: 403 });
      }
      const oauthReq = JSON.parse(atob(state));
      const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId: identity.email,
        metadata: { label: identity.email },
        scope: oauthReq.scope,
        props: { identity } satisfies Props,
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response("charter-gateway", { status: 200 });
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
```

- [ ] **Step 2: Typecheck**

Run: `cd gateway && npx tsc --noEmit`
Expected: no errors. If the installed `workers-oauth-provider` types disagree with the `OAUTH_PROVIDER` helper calls above, follow the installed types — that helper's exact name is the most likely thing to have moved.

- [ ] **Step 3: Confirm the whole suite still passes**

Run: `cd gateway && npx vitest run`
Expected: PASS (33 tests). This task adds no tests; it must not break existing ones.

- [ ] **Step 4: Smoke-run the Worker locally**

Run: `cd gateway && npx wrangler dev`
Then, in another shell:

```bash
curl -s -i http://localhost:8787/.well-known/oauth-authorization-server
```

Expected: HTTP 200 with a JSON body containing `authorization_endpoint`, `token_endpoint`, and `code_challenge_methods_supported` including `S256`. This proves `OAuthProvider` is mounted and advertising the metadata the MCP spec requires (§5). If `wrangler dev` refuses to start because `OAUTH_KV` has a placeholder id, create a local namespace with `npx wrangler kv namespace create OAUTH_KV --preview` and put the returned preview id in `wrangler.jsonc`; report that you did.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/index.ts gateway/wrangler.jsonc
git commit -m "feat(gateway): wire OAuthProvider + createMcpHandler"
```

---

### Task 5: Deploy, point core at the gateway's client, and verify end to end

**Files:**
- Create: `docs/deployment/gateway.md`
- Modify: `docs/configuration.md` (one row: the repointed Google client id)
- Modify: `docs/remote-mcp.md` (§6 sub-project table: mark B landed)

Steps 2 and 3 require Google Cloud Console access, a Cloudflare account, and a running core. **If you cannot perform them, write the runbook, complete Step 1 and Step 4, and report exactly which steps were documented but not executed. Do not fabricate output.**

- [ ] **Step 1: Write the operator runbook**

Create `docs/deployment/gateway.md`:

```markdown
# charter-gateway

The gateway is what Claude clients connect to. It terminates MCP and OAuth, and
translates to core. It holds the two secrets humans used to paste: the core
credential and the Google client secret.

Core is unchanged by this, with one exception — see "Repoint core" below.

## 1. Create the Google OAuth client

The gateway needs a **Web application** client (not the Desktop client the old
stdio proxy used — a web redirect cannot use a loopback URI).

In Google Cloud Console → APIs & Services → Credentials → Create credentials →
OAuth client ID → Web application:

- Authorized redirect URI: `https://<your-gateway-host>/callback`

Note the client id and secret.

## 2. Repoint core at that client

Core verifies the actor token's audience against its own configured client id,
so it must be the gateway's client id:

    gcloud run services update charter \
      --update-env-vars GOOGLE_OAUTH_CLIENT_ID=<gateway-web-client-id>

**This breaks the old stdio proxy** — tokens minted for the Desktop client stop
verifying. That is intended: the proxy is removed in the same release
(sub-project D). Do not repoint until you are ready to cut over.

## 3. Configure and deploy the gateway

    cd gateway
    npx wrangler kv namespace create OAUTH_KV
    # put the returned id into wrangler.jsonc's kv_namespaces entry

Set the non-secret values in `wrangler.jsonc` → `vars`:

- `CHARTER_CORE_URL` — your core endpoint, https only
- `CHARTER_ALLOWED_DOMAIN` — e.g. `@yourdomain.com`, matching core's setting
- `GOOGLE_CLIENT_ID` — from step 1

Then the two secrets, which are never written to a file:

    npx wrangler secret put CHARTER_CREDENTIAL      # cf-id:cf-secret:api-key
    npx wrangler secret put GOOGLE_CLIENT_SECRET

The credential is the same composite form the proxy used. Mint its API key with
`charter keys mint` and give it the allow-list the *gateway* needs — it is the
gateway's own credential, not a human's. Human scope comes from grants
(`docs/deployment/grants.md`), which core applies to the actor token.

    npx wrangler deploy

## 4. Connect a client

Add the endpoint to `.mcp.json`:

    {
      "mcpServers": {
        "charter": { "type": "http", "url": "https://<your-gateway-host>/mcp" }
      }
    }

The client discovers the OAuth metadata, opens a browser, and you sign in with
Google. No secret is pasted, and nothing is stored on your disk.

## Verifying

    curl -s https://<your-gateway-host>/.well-known/oauth-authorization-server | jq .

Expect `authorization_endpoint`, `token_endpoint`, and
`code_challenge_methods_supported` containing `S256`.

Then in a Claude conversation: `verbs.list` through `charter_read`. You should
see exactly the verbs your email is granted — if you see none, your email has no
grant (see `docs/deployment/grants.md`); if you get a 401, core is not pointed at
the gateway's Google client id (step 2).

## What the gateway does not do

- It makes **no authorization decision** and writes **no audit row**. Core
  verifies the Google token itself and applies grants.
- It never forwards the client's MCP token upstream. Calls to core use the
  gateway's own credential — the MCP spec forbids passthrough.
- **HubSpot connect is not available through the gateway yet.** That flow needs a
  loopback listener the old proxy had. Verbs needing a HubSpot identity return
  `hs_identity_required` until it is re-hosted.
```

- [ ] **Step 2: Deploy and verify the metadata endpoint**

```bash
cd gateway && npx wrangler deploy
curl -s https://<your-gateway-host>/.well-known/oauth-authorization-server | jq .
```

Expected: JSON containing `authorization_endpoint`, `token_endpoint`, and `code_challenge_methods_supported` including `"S256"`.

- [ ] **Step 3: Verify end to end from a client**

Point a client at `https://<your-gateway-host>/mcp`, complete the Google sign-in, and run `verbs.list` through `charter_read`.

Expected: the catalog scoped to that email's grant. Then confirm the negative case — a verb outside the grant returns `denied`, and an email with no grant gets `unauthorized`. Confirm core's audit table shows the calls with `interface = "oauth"` and the signed-in email as the actor. **That audit row is the proof that the gateway stayed non-authoritative:** the decision and the record both happened in core.

- [ ] **Step 4: Update the docs and commit**

In `docs/configuration.md`, add a note beside `GOOGLE_OAUTH_CLIENT_ID` that when the gateway is deployed this must be the gateway's **Web** client id, not the Desktop client's (`docs/deployment/gateway.md` step 2).

In `docs/remote-mcp.md` §6, change B's "Detailed plan" cell to reference this plan and mark it landed.

```bash
git add docs/deployment/gateway.md docs/configuration.md docs/remote-mcp.md
git commit -m "docs: gateway runbook, repointed google client, sub-project B status"
```

---

## Self-Review

**Spec coverage (`docs/remote-mcp.md`):**
- §2.1 gateway non-authoritative — no authorization logic anywhere in `gateway/src`; enforced by the Global Constraints and verified by Task 5 Step 3's audit check. ✓
- §2.2 core stands alone — nothing in this plan changes core except one env var (Task 5 Step 2). ✓
- §4.2 hosted translation, `charter_login` dropped — Task 3. ✓
- §4.3 OAuth 2.1 + PKCE + no passthrough — Task 4 (`OAuthProvider`), verified in Task 4 Step 4 / Task 5 Step 2 by the `S256` metadata check; passthrough is structurally impossible since `callCore` only ever sends `credHeaders` + the Google token. ✓
- §4.4 CF Access moves to the gateway — the credential is a Worker secret (Task 5 Step 3); `credHeaders` emits the CF headers. ✓
- §4.5 no `args_path`/`out_path` — Task 3, with the reason in the module docstring. ✓
- §4.6 audience, freshness, HubSpot out of scope — Task 2 (`freshIdToken`), Task 5 Step 2 (repoint), Task 3 (HubSpot excluded, documented). ✓
- §5 stateless, no DO, SDK owns the era — Task 4 module docstring and Global Constraints. ✓

**Placeholder scan:** no TBD or "handle errors appropriately". Two deliberate, named unknowns, each with an instruction rather than a blank: the dependency versions in Task 1 Step 1 (pin from `npm ls`, report a resolution failure) and the `OAuthProvider` helper API in Task 4 (follow the installed types, report the difference). `REPLACE_WITH_KV_NAMESPACE_ID` is a placeholder *value* consumed by Task 5's runbook, not a placeholder instruction.

**Type consistency:** `CoreConfig`/`CoreResult` (Task 1) are consumed unchanged by Tasks 3 and 4. `GoogleIdentity` (Task 2) is what `Props` wraps in Task 4 and what `freshIdToken` takes and returns. `handleTool`'s signature in Task 3 matches its call site in Task 4. `TOOL_INPUT_SHAPE` is a zod *shape* (a plain object of zod types), which is what `server.tool()` expects — not a `z.object()`.

**Known weak point:** Task 4 has no unit tests, by design — it is composition, and testing it meaningfully needs a Worker runtime and a live OAuth dance. Its risk is carried by the typecheck, the local smoke run, and Task 5's end-to-end verification. If Task 4 turns out to need real logic (beyond wiring), that logic belongs in a tested module, not in `index.ts`.

**Not covered here (later sub-projects):** the payload contract (C), distribution repackage and proxy removal (D), and the HubSpot connect re-host (§4.6, unscheduled).
