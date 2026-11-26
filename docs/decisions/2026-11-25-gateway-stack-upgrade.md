# Design: upgrade the gateway's MCP and OAuth stack

Date: 2026-11-25. Decided with Jason. Do this after PR #10 (result offload removed) merges, because that PR deletes the gateway's only resource registration and so leaves less to port.

## Problem

The gateway runs `agents` 0.4.0, `@modelcontextprotocol/sdk` 1.26 (v1) and `@cloudflare/workers-oauth-provider` 0.10.3. The current releases are `agents` 0.34.1, `@modelcontextprotocol/server` 2.4.0 (v2) and the provider 1.4.0. On the old stack the gateway can't speak the 2026-07-28 spec, which three follow-ups need:
- Skills over MCP (`@modelcontextprotocol/server/ext/skills` supports it natively);
- connecting through URL elicitation (which runs without stored state as `inputRequired`/MRTR);
- `tokenExchangeCallback` writing rotated Google identity back to the grant.

Nothing is broken today. This is the step that unblocks those three, and none of them is part of this design.

## Chosen approach: two PRs, provider first, no behaviour change

**PR 1: workers-oauth-provider 0.10.3 → 1.4.0.** This is the risky one, because it touches live sessions.
- Set `resourceMetadata.resource` to `<gateway origin>/mcp`, computed from the same configured origin `gateway_url.ts` already uses. The provider is built at module scope, so it reads that origin through `import { env } from "cloudflare:workers"` (or the provider is built per request).
  - Prod check (2026-11-25): of 13 grants in `OAUTH_KV`, 12 carry `https://ops-bridge-gw.radicalcandor.com/mcp` and 1 carries the bare origin. With `/mcp`, that one session signs in again and the other 12 continue.
  - The headless hostname `ops-bridge.radicalcandor.com` serves only `/call` and holds no grants.
- Keep `clientRegistrationEndpoint: "/register"`, which 1.x turns off by default, and `clientIdMetadataDocumentEnabled: true`. Sign-in behaves exactly as today.
- Delete `allowPlainPKCE`, which no longer exists.
- Handle `CimdFetchError` where `lookupClient` and `parseAuthRequest` are called.
- Confirm that no `completeAuthorization` `userId` contains `:`.
- Decide whether the provider's own protected-resource metadata replaces `prm.ts`; take the provider's if it serves both well-known paths.
- Staging gate: carry one session from the 0.x deploy across the upgrade, then refresh it and make an API call. Prod deploys only after both succeed.

**PR 2: agents 0.34.1 + `@modelcontextprotocol/server` 2.4.0 + zod 4.** This changes the code's shape, not its behaviour.
- `createMcpHandler` from `agents/mcp/server`, given a factory: `() => buildServer(env, actorToken, …)`, still a fresh server per request.
- `legacy: "stateless"` (the default), so 2025-11-25 clients keep working.
- `McpServer` comes from `@modelcontextprotocol/server`. Handlers take `(args, ctx)`, and `traceparent` is read from `ctx.mcpReq._meta`.
- Zod 4 needs `z.record(z.string(), z.unknown())` in `tools.ts`.
- Remove `@modelcontextprotocol/sdk`.
- Tests pin the three contracts that matter: the 2-tool surface, `traceparent` reaching the audit header, and a 2025-11-25 client completing a tool call.
- Staging: one Claude Code session and one claude.ai session each run `verbs.list` and a write verb.

## Cut and why

- **Skills over MCP.** Jason left it out of this design; it gets a separate design, including where skills come from.
- **CIMD-only, a client allowlist, deleting `redirect_uri.ts`.** It needs claude.ai's client ID, captured from a live sign-in on the upgraded gateway. It also breaks clients that don't support CIMD. Follow-up.
- **Connecting through URL elicitation.** Whether claude.ai web offers URL mode is unconfirmed. The pasted-code flow works. Follow-up, after a live test.
- **`tokenExchangeCallback` write-back.** A real but rare failure (Google rarely rotates refresh tokens for web clients). It becomes possible after PR 1, but it is not needed for it. Follow-up.
- **MCP tasks.** 23 `finance.cash_flow.refresh` runs since the cutover, all ok, with no timeouts in the audit or in Sentry. The stateless handler doesn't support tasks anyway.
- **Upgrading wrangler and the compatibility date.** The current flags (`nodejs_compat`, `global_fetch_strictly_public`) and the 2026-07-01 date already meet the new packages' requirements.

## Open questions

- Does `server/discover` list extension capabilities on agents 0.34? Not needed until skills; check in PR 2's staging.
- `@cloudflare/vitest-pool-workers` 0.12 may need a bump to run the v2 packages. PR 2 finds out.

## Deviations

- T1 commit 60a6270 — deviation: none (review p3 "no garbage-bearer 401 assertion" folded into T2) — parked: none
- T2 commit 7608cd7 (+ 79c3b46 review comment/doc fixes) — deviation: added garbage-bearer 401 test (T1 review p3); prm.ts stale comment and whole-sentence remote-mcp.md rewrite; CIMD local-400 test failed pre-bump (plan did not predict it; 0.10.3 echoed the URL). Accepted unfixed p3s: lazy provider construction moves a hypothetical constructor error from deploy to first request; a client sending resource=<bare origin> at /authorize sees the generic redirect_uri preamble before the invalid_target message (the one expected re-sign-in) — parked: none
