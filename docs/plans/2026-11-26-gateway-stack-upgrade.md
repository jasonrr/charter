# Plan: gateway OAuth provider 0.10.3 → 1.4.0 (PR 1 of the stack upgrade)

- **Goal:** move `gateway/` to `@cloudflare/workers-oauth-provider` 1.4.0. Sign-in must behave as it does today, and existing `/mcp`-bound sessions must carry over. This plan covers **PR 1 only**. PR 2 (agents 0.34 + the v2 MCP server + zod 4) gets its own plan after this one passes the staging gate (Task 3), because the design makes that gate a hard dependency.
- **Design:** `docs/decisions/2026-11-25-gateway-stack-upgrade.md`
- **Branch:** `chore/gateway-stack-upgrade`, one PR. /forge:build creates the worktree, commits this plan and the design first, makes one commit per task, and opens the draft PR. Commit messages and the PR body carry no AI attribution lines.
- **Base:** `origin/main`. PR #10 (result offload removal) does not need to merge first, because this plan doesn't touch the resource registration or the results code.
- **Whole-feature verify:** `cd gateway && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`. Use the binaries directly: `npx tsc` goes through the RTK wrapper, which fakes success.

## Background the implementer needs

**Reference.** After Task 2 step 2 installs 1.4.0, read these sections of `gateway/node_modules/@cloudflare/workers-oauth-provider/docs/migration-1.x.md`:
- "The canonical resource is required";
- "Match the resource your existing grants carry";
- "Removed: the implicit grant and plain PKCE";
- "Existing stored data: nothing to do".

The types are in `dist/oauth-provider.d.ts`. `resourceMetadata` needs only `resource`, because the provider fills in the rest.

**The rule that matters most.**
- 1.x binds every grant and token to one configured `resourceMetadata.resource`, compared exactly. Existing grants keep working only if that value equals the `resource` they were stored with.
- Grants stored with *no* `resource` bind to the configured one on their next refresh.
- Prod census, 2026-11-25: 12 of 13 grants carry `https://ops-bridge-gw.radicalcandor.com/mcp` and 1 carries the bare origin.
- So the configured resource is `gatewayOrigin(env.CHARTER_GATEWAY_URL) + "/mcp"`. `gatewayOrigin` is in `gateway/src/gateway_url.ts`, and `MCP_PATH = "/mcp"` is in `gateway/src/prm.ts`.
- The bare-origin session signs in once more. The design accepts this.

**Facts verified by reading the 1.4.0 source.** Don't re-derive these.
- KV key formats are identical in 0.10.3 and 1.4.0: `grant:<userId>:<grantId>` and `token:<userId>:<grantId>:<tokenId>`. The grant's `resource` is stored in plain text.
- The provider matches its token, register and authorization-server-metadata endpoints, and `apiRoute: "/mcp"`, by path only, on any host. So headless `/call`, served on a second prod hostname, still reaches `authHandler`.
- The constructor builds a per-instance JWKS cache, used by CIMD `private_key_jwt` clients. That's why Task 2 memoizes the provider instead of building it per request.
- `fetchForRoles` sets `env.OAUTH_PROVIDER` once per isolate. The memo keeps that consistent.
- 1.4 omits `resource_metadata` on a 401 when the request's origin isn't the configured resource's. `withResourceMetadata` (`index.ts:1080-1103`) therefore still does real work for foreign-host requests. Keep it.
- A refresh naming a resource that isn't configured gets `400`, with `error` set to `invalid_target` (1.4) or `invalid_grant`.
- `completeAuthorization`'s `userId` is the verified Workspace email, pinned to `CHARTER_ALLOWED_DOMAIN` (`index.ts:736-742`, `google.ts:147-156`). It can't contain `:`, and if it ever did, 1.x throws inside the existing `try`. No guard is needed.
- `AuthRequest.resource` is now a single string. `src/` never reads it, and `state.ts` only serializes it.

**Current wiring.**
- The provider is a module-scope `const provider = new OAuthProvider({...})` at `gateway/src/index.ts:936-964`.
- It is used at `index.ts:1040`, inside `screenRegistration`, and at `index.ts:1145`, in the default export's `fetch` (1105-1149).
- PRM is served by `prm.ts` before the provider (`index.ts:1113-1138`).
- With an invalid `CHARTER_GATEWAY_URL`, sign-in routes already fail with named 503s (`missingConfig` / `gatewayUrlProblem`, `index.ts:482-495`), and `/mcp` 401s go undecorated.

**Tests.**
- Vitest with `@cloudflare/vitest-pool-workers` 0.12.21. Config is `gateway/vitest.config.ts`, and env comes from `gateway/wrangler.test.jsonc` (`CHARTER_GATEWAY_URL` = `https://charter-gateway.example.com`, `CHARTER_ALLOWED_DOMAIN` = `@example.com`).
- Flow helpers are in `gateway/test/index.wiring.test.ts`:
  - `fullEnv` (30-38), `call` (40-50), `startFlow` (57-89) and `consent` (92-105);
  - `stubGoogleSignIn` and `consentedFlow`, inside the `/callback` describe at about 263-288;
  - the module-scope `afterEach(() => vi.unstubAllGlobals())` at line 117, which covers every describe in the file.
- KV is isolated per test. Always consume response bodies (`await res.text()` or `.json()`), because unread bodies can trip isolated storage.

## Task 1
**End-to-end OAuth regression test on the current provider**

- **Exists because:** no test exchanges a code at `/token` or calls `/mcp` with a bearer token. `grep -rn "grant_type" gateway/test` finds only Google calls. Without this, an upgrade that breaks token issuance, audience binding or refresh would pass the suite.
- **Model:** sonnet
- **Files:** `gateway/test/index.wiring.test.ts` only.
- **Interfaces:**
  - Consumes `fullEnv`, `call`, `consent` and `stubGoogleSignIn`.
  - Produces the describe block `"OAuth end to end (authorize → token → /mcp → refresh)"` with helpers `signIn(env, { resource? })`, `mcpInitialize` and `refresh`, plus module-scope `VERIFIER`, `s256` and `RESOURCE`. Task 2 adds tests to this block and uses `s256`/`VERIFIER`.

Steps:

1. **Generalise `startFlow`.**
   - New signature: `startFlow(env: Env, extra: Record<string, string> = {}): Promise<{ state: string; cookie: string; clientId: string }>`.
   - Spread `extra` into the `/authorize` `URLSearchParams` object literal *after* the existing keys, so it can override `code_challenge`.
   - Return `client_id` as `clientId`.
   - Existing callers destructure only `state`/`cookie` and need no change.
2. **Move `stubGoogleSignIn`** out of the `/callback` describe to module scope, directly below `spyOnUpstreamFetch`, unchanged. `consentedFlow` stays where it is and keeps calling it.
3. **Add module-scope PKCE constants**, below `stubGoogleSignIn`:

   ```ts
   const VERIFIER = "charter-e2e-verifier-0123456789-abcdefghijklmnop"; // RFC 7636: 43-128 chars of [A-Za-z0-9-._~]
   async function s256(verifier: string): Promise<string> {
     const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
     return btoa(String.fromCharCode(...new Uint8Array(digest)))
       .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
   }
   const RESOURCE = `${ORIGIN}/mcp`;
   ```

4. **Append the describe block** at the end of the file:

   ```ts
   describe("OAuth end to end (authorize → token → /mcp → refresh)", () => {
     type Tokens = { access_token: string; refresh_token: string };

     /**
      * Full sign-in. By default sends RFC 8707 `resource` at /authorize and
      * /token as Claude does; `{ resource: null }` signs in as a client that
      * never sends one.
      */
     async function signIn(
       env: Env,
       opts: { resource?: string | null } = {},
     ): Promise<{ clientId: string; tokens: Tokens }> {
       const resource = opts.resource === undefined ? RESOURCE : opts.resource;
       const withResource: Record<string, string> = resource ? { resource } : {};
       const started = await startFlow(env, { code_challenge: await s256(VERIFIER), ...withResource });
       const state = await consent(env, started.state, started.cookie);
       stubGoogleSignIn("someone@example.com");
       const cb = await call(env, `/callback?state=${encodeURIComponent(state)}&code=good`, {
         headers: { Cookie: started.cookie },
       });
       await cb.text();
       expect(cb.status).toBe(302);
       const code = new URL(cb.headers.get("Location")!).searchParams.get("code")!;
       const res = await call(env, "/token", {
         method: "POST",
         headers: { "Content-Type": "application/x-www-form-urlencoded" },
         body: new URLSearchParams({
           grant_type: "authorization_code",
           code,
           redirect_uri: REDIRECT_URI,
           client_id: started.clientId,
           code_verifier: VERIFIER,
           ...withResource,
         }).toString(),
       });
       const body = await res.text();
       expect(res.status, body).toBe(200);
       const tokens = JSON.parse(body) as Tokens;
       expect(tokens.access_token).toBeTruthy();
       expect(tokens.refresh_token).toBeTruthy();
       return { clientId: started.clientId, tokens };
     }

     /** POST an MCP initialize; returns status and the consumed body. */
     async function mcpInitialize(env: Env, accessToken: string): Promise<{ status: number; body: string }> {
       const res = await call(env, "/mcp", {
         method: "POST",
         headers: {
           Authorization: `Bearer ${accessToken}`,
           "Content-Type": "application/json",
           Accept: "application/json, text/event-stream",
         },
         body: JSON.stringify({
           jsonrpc: "2.0",
           id: 1,
           method: "initialize",
           params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
         }),
       });
       return { status: res.status, body: await res.text() };
     }

     function refresh(env: Env, clientId: string, refreshToken: string, resource: string | null): Promise<Response> {
       const params: Record<string, string> = {
         grant_type: "refresh_token",
         refresh_token: refreshToken,
         client_id: clientId,
       };
       if (resource) params.resource = resource;
       return call(env, "/token", {
         method: "POST",
         headers: { "Content-Type": "application/x-www-form-urlencoded" },
         body: new URLSearchParams(params).toString(),
       });
     }

     it("issues a token that /mcp accepts", async () => {
       const env = fullEnv();
       const { tokens } = await signIn(env);
       const res = await mcpInitialize(env, tokens.access_token);
       expect(res.status, res.body).toBe(200);
       expect(res.body).toContain('"result"');
     });

     it("refreshes for the same resource, and the new token works on /mcp", async () => {
       const env = fullEnv();
       const { clientId, tokens } = await signIn(env);
       const res = await refresh(env, clientId, tokens.refresh_token, RESOURCE);
       const body = await res.text();
       expect(res.status, body).toBe(200);
       const next = JSON.parse(body) as Tokens;
       expect((await mcpInitialize(env, next.access_token)).status).toBe(200);
     });

     it("serves a client that never sends `resource`, through sign-in and refresh", async () => {
       const env = fullEnv();
       const { clientId, tokens } = await signIn(env, { resource: null });
       expect((await mcpInitialize(env, tokens.access_token)).status).toBe(200);
       const res = await refresh(env, clientId, tokens.refresh_token, null);
       const body = await res.text();
       expect(res.status, body).toBe(200);
       expect((await mcpInitialize(env, (JSON.parse(body) as Tokens).access_token)).status).toBe(200);
     });
   });
   ```

5. **Run the suite.** All three new tests must pass on 0.10.3, because they pin today's behaviour.
   - The adversarial review traced them as passing on 0.10.3. The `/mcp` handler doesn't fetch while the stubbed id token is unexpired, and `initialize` doesn't call core.
   - If one fails anyway, don't weaken an assertion, drop `resource`, or stub core. Stop and report `blocked` with the failing test's status and body.

- **Verify:** `cd gateway && ./node_modules/.bin/vitest run test/index.wiring.test.ts && ./node_modules/.bin/tsc --noEmit`

## Task 2
**Upgrade to workers-oauth-provider 1.4.0 with the resource pinned to `<CHARTER_GATEWAY_URL origin>/mcp`**

- **Exists because:** the design's follow-ups need 1.x (`tokenExchangeCallback` with `env`, `invalid_grant` revocation). 1.x refuses to construct without a pinned resource, and a wrong resource signs every existing session out.
- **Model:** sonnet
- **Files:**
  - `gateway/package.json`, `gateway/package-lock.json`;
  - `gateway/src/index.ts`, `gateway/src/prm.ts`;
  - `gateway/test/index.wiring.test.ts`, `gateway/test/prm.test.ts`;
  - `docs/deployment/gateway.md`, `docs/remote-mcp.md`.
- **Interfaces:**
  - Consumes Task 1's describe block and its helpers.
  - Produces `providerFor(origin: string): OAuthProvider`, internal to `index.ts`.
  - Changes `screenRegistration` to take the provider as a fourth parameter.

Steps:

1. **Write the failing or new tests first.**
   - **(a) Mismatched-resource refresh.** In Task 1's describe block:

     ```ts
     it("refuses a refresh for the bare origin: grants are bound to /mcp exactly", async () => {
       const env = fullEnv();
       const { clientId, tokens } = await signIn(env);
       const res = await refresh(env, clientId, tokens.refresh_token, ORIGIN);
       expect(res.status).toBe(400);
       const { error } = (await res.json()) as { error: string };
       expect(["invalid_target", "invalid_grant"]).toContain(error);
     });
     ```

     This may already pass on 0.10.3, and it must pass after the upgrade.
   - **(b) Bare PRM root no longer answers.** In `gateway/test/prm.test.ts`:
     - The first test asserts `expect(protectedResourceOf("/.well-known/oauth-protected-resource")).toBe("")` (about line 19). Delete that line from the first test.
     - Rename that test `"recognises the path-suffixed well-known path"`, and replace its comment with `// Only the /mcp document is served: 1.x binds every token to <origin>/mcp, so a document naming the bare origin would hand clients a resource the server refuses.`
     - Add `"/.well-known/oauth-protected-resource"` to the `"claims nothing else"` list.
     - In the `"protectedResourceMetadata"` describe, delete the line `expect(protectedResourceMetadata(ORIGIN, "").resource).toBe(ORIGIN);` and the comment above that test about "each path".
     - The `"claims nothing else"` test now fails until step 4.
   - **(c) The bare root through the worker.** In `index.wiring.test.ts`, add a describe `"protected-resource metadata through the worker"`:

     ```ts
     it("serves the /mcp document and 404s the bare root", async () => {
       const doc = await call(fullEnv(), "/.well-known/oauth-protected-resource/mcp");
       expect(doc.status).toBe(200);
       expect(((await doc.json()) as { resource: string }).resource).toBe(`${ORIGIN}/mcp`);
       const root = await call(fullEnv(), "/.well-known/oauth-protected-resource");
       await root.text();
       expect(root.status).toBe(404);
     });

     it("keeps the named sign-in 503 when CHARTER_GATEWAY_URL is invalid (provider construction never pre-empts it)", async () => {
       const env = fullEnv({ CHARTER_GATEWAY_URL: "not a url" });
       const authorize = await call(env, "/authorize?response_type=code&client_id=x");
       const text = await authorize.text();
       expect(authorize.status).toBe(503);
       expect(text).toContain("CHARTER_GATEWAY_URL");
     });
     ```

     For the second test, first read `index.ts:482-495` to confirm the exact status and wording `gatewayUrlProblem`/`missingConfig` produce for an invalid value. Assert what that code produces today; the test must pass both before and after the upgrade. It pins that the provider's construction never pre-empts those messages.
2. **Bump the dependency:** `cd gateway && npm install @cloudflare/workers-oauth-provider@^1.4.0`.
   - `package.json` must read `"^1.4.0"`.
   - The lockfile diff should touch only that package and its own dependencies.
   - If npm reports peer-dependency conflicts or changes `agents` / `@modelcontextprotocol/sdk`, stop and report.
   - Then read the migration-guide sections listed in Background.
3. **Build the provider from the configured origin, memoized.**
   - Replace the module-scope `const provider = new OAuthProvider({...})` (`index.ts:936-964`). Keep the existing comment at 932-935 about the handler casts above the new function:

     ```ts
     // An origin that never matches a real request, used only when
     // CHARTER_GATEWAY_URL is invalid. With it the provider still constructs,
     // so /call and the named sign-in 503s (gatewayUrlProblem/missingConfig)
     // behave as before. Sign-in refuses to run in that state, so no token is
     // ever issued for it.
     const UNCONFIGURED_ORIGIN = "https://unconfigured.invalid";

     // One provider per configured origin. The resource comes from env, so it
     // can't be built at module scope, and the constructor holds a per-instance
     // JWKS cache for CIMD private_key_jwt clients, so it isn't rebuilt per
     // request. The origin is constant per deployment; tests vary it per env.
     let cached: { origin: string; provider: OAuthProvider } | undefined;
     function providerFor(origin: string): OAuthProvider {
       if (cached?.origin !== origin) cached = { origin, provider: makeProvider(origin) };
       return cached.provider;
     }

     function makeProvider(origin: string): OAuthProvider {
       return new OAuthProvider({
         apiRoute: MCP_PATH,
         apiHandler: apiHandler as unknown as OAuthProviderOptions["apiHandler"],
         defaultHandler: authHandler as unknown as OAuthProviderOptions["defaultHandler"],
         authorizeEndpoint: "/authorize",
         tokenEndpoint: "/token",
         // 1.x turns DCR off by default; Claude and older clients still register here.
         clientRegistrationEndpoint: "/register",
         // Every grant and token is bound to this exact value (RFC 8707), and
         // existing grants carry `${origin}/mcp`. Changing it signs every user
         // out: see docs/deployment/gateway.md "Provider 1.x resource".
         resourceMetadata: { resource: `${origin}${MCP_PATH}` },
         // S256-only PKCE is the 1.x default (plain was removed in 1.2).
         // <keep the existing CIMD comment block from index.ts:952-962 verbatim here>
         clientIdMetadataDocumentEnabled: true,
       });
     }
     ```

   - **Casts.** If `OAuthProviderOptions["apiHandler"]` / `["defaultHandler"]` no longer exist as property types in 1.x and the casts fail to compile, cast through `unknown` to whatever type 1.x's `OAuthProviderOptions<Env>` declares for that property (read `dist/oauth-provider.d.ts`, `interface OAuthProviderOptions` at about line 956). Do not change either handler's runtime signature.
   - **Delete** `allowPlainPKCE: false` and its comment (lines 944-951).
   - **In the default export's `fetch`** (`index.ts:1105-1149`):
     - After the PRM block, add `const provider = providerFor(origin || UNCONFIGURED_ORIGIN);`.
     - Pass `provider` to `screenRegistration(request, env, ctx, provider)`, and add the parameter `provider: OAuthProvider` to `screenRegistration`'s signature. Use it at the former line 1040.
     - The existing `provider.fetch(request, env, ctx)` and the `withResourceMetadata` call stay as they are.
   - **Correct the comment** above `withResourceMetadata` (`index.ts:1080-1103`). It should say: 1.x omits `resource_metadata` on 401s for requests whose origin isn't the configured resource's, and this function supplies the configured URL in every case.
   - **The existing test** `"leaves the 401 undecorated when CHARTER_GATEWAY_URL is invalid"` (`index.wiring.test.ts:437-442`) must still pass unchanged.
4. **Stop serving the bare PRM root.**
   - In `prm.ts`, delete `if (pathname === PRM_ROOT) return "";` from `protectedResourceOf`.
   - Rewrite `protectedResourceOf`'s doc comment as: "RFC 9728 §3.1 inserts the well-known segment before the resource's path, so `https://gw/mcp` is described at `https://gw/.well-known/oauth-protected-resource/mcp`. Only that document is served. The bare root would have to name the bare origin (RFC 9728 §3.3 requires `resource` to match the URL it was derived from), and 1.x binds every token to `<origin>/mcp`, so the provider would refuse a client that bound to it. The bare root falls through to the provider, which answers 404. MCP clients try the path-suffixed URL first, and the 401's `resource_metadata` names it."
   - **Why:** the one bare-origin prod grant came from a client that fell back to the root document. Under 1.x that client would be refused at `/authorize` (`invalid_target`). A 404 sends it back to the path-suffixed document instead, which conforms.
   - Do not replace `prm.ts` with the provider's metadata. `prm.ts` pins the configured origin against a hostile Host header (test at `index.wiring.test.ts:420`).
5. **CIMD fetch failures render locally without echoing the URL.**
   - In 1.x, `parseAuthRequest` throws `CimdFetchError`, whose message embeds the attacker-supplied metadata URL and fetch detail. The catch at `index.ts:548-561` echoes `e.message` and claims it's "fixed library strings", which is no longer true.
   - Change the catch:

     ```ts
     } catch (e) {
       if (e instanceof CimdFetchError) {
         console.warn("cimd fetch failed", { reason: e.reason });
         return browserError(
           "charter could not start sign-in for this client: its client metadata " +
             "document could not be fetched or is invalid.",
           400,
         );
       }
       // …existing comment and browserError(...) unchanged…
     }
     ```

     Import `CimdFetchError` from `@cloudflare/workers-oauth-provider`. `reason` is a stable code, not caller input.
   - Leave `lookupClient`'s catch (`index.ts:699-704`) unchanged. It already returns a fixed message.
   - Add to the `"CIMD (client_id as a metadata document URL)"` describe. The inline `vi.stubGlobal` is deliberate; don't make a helper:

     ```ts
     it("renders a local 400, never a redirect or the URL, when the metadata document can't be fetched", async () => {
       vi.stubGlobal("fetch", (async () => new Response("down", { status: 503 })) as typeof fetch);
       const res = await call(fullEnv(), "/authorize?" + new URLSearchParams({
         response_type: "code",
         client_id: CIMD_URL,
         redirect_uri: "https://client.example/cb",
         state: "s",
         code_challenge: await s256(VERIFIER),
         code_challenge_method: "S256",
       }).toString());
       const body = await res.text();
       expect(res.status).toBe(400);
       expect(res.headers.get("Location")).toBeNull();
       expect(body).not.toContain(CIMD_URL);
     });
     ```

6. **Rename** the describe `"PKCE S256 enforcement (allowPlainPKCE: false)"` (`index.wiring.test.ts:364`) to `"PKCE S256 enforcement"`. Its assertions are unchanged.
7. **Typecheck:** run `./node_modules/.bin/tsc --noEmit` and fix what 1.x's type changes break.
   - Expected sites are the handler casts (step 3) and possibly `OAuthHelpers` / `AuthRequest` usage in `index.ts` and `state.ts`.
   - A fix "changes behaviour" if it alters any runtime value, branch or response. If one would, stop and report it with the error.
8. **Docs.** Edit each of these sites:
   - **`docs/deployment/gateway.md` ~303-307.** Replace "The bare `/.well-known/oauth-protected-resource` is served too, describing the origin itself rather than `/mcp` — clients probe both." with "The bare `/.well-known/oauth-protected-resource` answers 404: tokens are bound to `/mcp`, and clients find the path-suffixed document first."
   - **`docs/deployment/gateway.md` ~311-315.** Replace "(`allowPlainPKCE: false` in `src/index.ts`)" with "(S256-only is the provider's 1.x default)". Replace "or a provider older than 0.8" with "or a provider older than 1.2".
   - **`docs/deployment/gateway.md` ~488-494 (Known limitations).** Replace "Provider `0.8.x` added `allowPlainPKCE`; the gateway sets it `false`, so" with "Provider 1.2 removed plain PKCE entirely, so".
   - **`docs/remote-mcp.md` ~220-224.** Replace "so both paths are served, each reporting the resource *its own* URL identifies — a client that derived the URL checks `resource` against it." with "so that path is served. The bare root answers 404, because every token is bound to `<origin>/mcp` and a root document would have to name the bare origin (RFC 9728 §3.3)."
   - **`docs/remote-mcp.md` ~552-557.** Replace "Provider `0.8.x` added `allowPlainPKCE`; the gateway sets it to `false`, so" with "Provider 1.2 removed plain PKCE, so".
   - **New subsection in `docs/deployment/gateway.md`:** `### Provider 1.x resource`, as the last subsection of `## Cutover from the stdio proxy (one-time)`, just before `## Staging`:

     ```markdown
     ### Provider 1.x resource

     Since `@cloudflare/workers-oauth-provider` 1.x, every grant and token is bound to exactly
     `<CHARTER_GATEWAY_URL origin>/mcp`. Changing `CHARTER_GATEWAY_URL`'s origin signs every user
     out. A mismatch shows as `401 invalid_token` on `/mcp` or `400 invalid_grant` / `invalid_target`
     on refresh.

     Before deploying a provider upgrade, check what live grants carry (run in `gateway/`, with the
     deployment's wrangler config):

         npx wrangler kv key list --binding OAUTH_KV --remote --prefix grant: --config <config> \
           | jq -r '.[].name' | while read -r key; do
               npx wrangler kv key get --binding OAUTH_KV --remote --config <config> "$key" | jq -r .resource
             done | sort | uniq -c

     Grants carrying any other value sign in once more after the deploy. Grants with no `resource`
     bind to `/mcp` on their next refresh. CIMD clients' grants are no longer revoked when the same
     user signs in again (1.4: their client_id is shared by every installation), so they accumulate
     until they expire.
     ```

- **Verify:** `cd gateway && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`. The whole suite must be green, with Task 1's tests unchanged.

## Task 3
**Staging gate: a pre-upgrade session survives the upgrade (operator task)**

- **Exists because:** the design forbids a prod deploy until a session created on 0.x refreshes and makes an API call on 1.4. No unit test can produce a grant record written by the old library, and those records are the risk.
- **Model:** sonnet. The build agent runs every command. Steps marked **HUMAN** need the person: ask them, then wait for their confirmation.
- **Files:** none committed. Results go in the draft PR body (build opens it at the start) under `## Staging gate`.
- **Definitions:**
  - `ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")` is the main checkout.
  - `WT` is this branch's worktree root.
  - `CFG=wrangler.staging.jsonc`.
  - Staging is `https://charter-gateway-staging.radical-candor.workers.dev`. Its config has no containers, so no Docker is needed, and its secrets are already set.
- **Prerequisite:** `wrangler.staging.jsonc` is git-ignored, so copy it: `cp "$ROOT/gateway/wrangler.staging.jsonc" "$WT/gateway/"`.

Steps:

1. **Snapshot the grants before the human's sign-in:** `cd "$WT/gateway" && npx wrangler kv key list --binding OAUTH_KV --remote --prefix grant: --config $CFG | jq -r '.[].name' | sort > "$WT/.gate-before.txt"`.
2. **Deploy 0.x from `main`:**

   ```sh
   git -C "$ROOT" fetch origin main
   git -C "$ROOT" worktree add "$ROOT/.claude/worktrees/main-gate" origin/main
   cp "$ROOT/gateway/wrangler.staging.jsonc" "$ROOT/.claude/worktrees/main-gate/gateway/"
   cd "$ROOT/.claude/worktrees/main-gate/gateway" && npm ci && npx wrangler deploy --config $CFG
   ```

   Then confirm 0.10.3 is installed: `jq -r '.packages["node_modules/@cloudflare/workers-oauth-provider"].version' package-lock.json` must print `0.10.3`.
3. **HUMAN: create a 0.x session.**
   - In a terminal they run `claude mcp remove charter-staging 2>/dev/null; claude mcp add --transport http charter-staging https://charter-gateway-staging.radical-candor.workers.dev/mcp`.
   - In a new Claude Code session they run `/mcp`, authenticate `charter-staging` (Google sign-in with their `@radicalcandor.com` account), then ask Claude to call `charter_read` with verb `verbs.list`.
   - They confirm it returned verbs and keep that session open.
4. **Find and record the new grant.**
   - `cd "$WT/gateway"`.
   - List the grant keys again into `.gate-after.txt` (same command as step 1). The new key is `comm -13 "$WT/.gate-before.txt" "$WT/.gate-after.txt"`. Exactly one key is expected; if there are several, pick the one whose `userId` segment is the human's email.
   - Run `npx wrangler kv key get --binding OAUTH_KV --remote --config $CFG "<key>" | jq '{resource, clientId, refreshTokenId, previousRefreshTokenId}'`, and paste the output into the PR body.
   - The expected `resource` is `https://charter-gateway-staging.radical-candor.workers.dev/mcp`. If it is `null` (the client sent none), continue: 1.x binds it on refresh. Note it in the PR body. Any other value means the gate is **failed** before the upgrade; report it.
5. **Deploy the branch:** `cd "$WT/gateway" && npm ci && npx wrangler deploy --config $CFG`.
6. **HUMAN: API call on the 0.x access token.** In the *same* Claude Code session, call `verbs.list` again. It must succeed with no sign-in prompt.
7. **Force a refresh and prove it happened.**
   - List that grant's access tokens with `npx wrangler kv key list --binding OAUTH_KV --remote --prefix "token:<userId>:<grantId>:" --config $CFG`, taking `<userId>` and `<grantId>` from the grant key `grant:<userId>:<grantId>`.
   - Delete each with `npx wrangler kv key delete --binding OAUTH_KV --remote --config $CFG "<key>"`.
   - Wait 90 seconds, because KV edge reads can serve a deleted value for up to 60 s.
   - Start `npx wrangler tail --config $CFG --format pretty` in the background, writing to `"$WT/.gate-tail.log"`.
   - **HUMAN:** call `verbs.list` again in the same session. It must succeed with no browser sign-in.
   - Stop the tail. Re-read the grant with the step 4 `jq`. Pass requires **all three**:
     - `refreshTokenId` differs from step 4's value (proof that a refresh ran);
     - `resource` is `…/mcp`;
     - the tail log shows `POST /token` returning 200.
8. **Clean up:**
   - `git -C "$ROOT" worktree remove "$ROOT/.claude/worktrees/main-gate"`.
   - `rm "$WT/.gate-before.txt" "$WT/.gate-after.txt" "$WT/.gate-tail.log" "$WT/gateway/wrangler.staging.jsonc"`.
   - Leave staging on the branch build.
9. **Gate result.**
   - **Pass** (steps 6 and 7 both pass): write `Staging gate: PASS` with the grant JSON from steps 4 and 7 into the PR body.
   - **Fail:** do not change code to work around it. Report `blocked` with the exact error, the grant JSON and the tail excerpt.
   - **Prod is out of this PR's scope.** It deploys from rc-data-tools after merge via the `CHARTER_SHA` bump. The human first runs the census from the new `### Provider 1.x resource` doc section against prod, and exactly one prod user (the bare-origin grant) is expected to sign in again.

- **Verify:** the PR body contains `Staging gate: PASS`, the step 4 and step 7 grant JSON with differing `refreshTokenId`s, and the human's confirmation of steps 6 and 7.
