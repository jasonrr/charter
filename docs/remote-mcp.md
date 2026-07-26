# Charter gateway + core — design spec

**Status:** design; all decisions locked. **Scope:** single tenant.
**Replaces:** the local stdio proxy + `.mcpb` + pasted composite credential —
removed outright in the release that ships the gateway (§7.1); no adopters to
migrate. Headless agents keep API keys against core's HTTP API, unchanged.

## 1. Goal

Interactive users install charter once, sign in with Google, and never paste a
secret. Identity is captured at install; authorization follows the identity.
This is the PostHog plugin shape: a remote HTTP MCP endpoint the client reaches
directly, with client-driven OAuth — no local proxy process, no `user_config`
secret form, reaches every surface (Code, Desktop, web, Cowork).

## 2. The split: gateway and core

Charter becomes two deployables with one contract between them.

- **charter-gateway** — terminates *protocol and identity*. Speaks MCP
  (Streamable HTTP + OAuth) to clients; speaks charter's `{"verb", ...args}`
  HTTP contract to core. Tracks the **MCP spec**.
- **charter-core** — *governed execution*. Verb registry, dispatch, packs, SDK,
  authorization, audit. Tracks **charter's own semantics**. This is today's
  Python engine, unchanged in kind. (Its HTTP entry point keeps its code name,
  `charter.main.bridge`.)

### 2.1 Invariant: the gateway is non-authoritative

**The gateway never decides what a caller may do, and never writes audit.**
Every authorization decision and every governed side effect belongs to core.

Load-bearing consequence: **core verifies the Google ID token itself** — it
already does (`actor_auth.actor_email`). The gateway *presents* the token; core
*verifies* it. The gateway is never trusted to assert "this caller is
jason@…". A compromised gateway therefore cannot forge an identity: it has no
way to mint a Google-signed token. This is why §4.1 puts identity→scope in core
rather than at the front door.

### 2.2 Invariant: core stands alone

**Core must remain independently deployable and useful without the gateway.**
Charter is open source; requiring a specific vendor's edge runtime would couple
adopters to that vendor. So:

- The gateway is *a reference implementation*, swappable. Nothing stops an
  adopter writing a Node, Deno, or Python one — the contract is plain HTTP.
- Core stays reachable directly over HTTP (that's how `packtest`, curl
  verification, and headless agents already talk to it).
- The two-deployable operational burden is **opt-in**, not imposed.

### 2.3 Why this boundary earns its name

Charter's bespoke `{"verb", ...args}` HTTP contract looked like legacy. It is
actually **the insulation layer**. The MCP spec rewrote its entire transport for
the 2026-07-28 revision (§5) — and none of it reaches core. Spec churn hits the
gateway only. That converts "the MCP spec keeps moving" from an existential
problem into a contained one, and it is the reason to make this a first-class
boundary instead of a deployment detail.

### 2.4 What lives where

| | charter-gateway | charter-core |
|---|---|---|
| **Tracks** | the MCP spec | charter semantics |
| **Language/runtime** | TS on Workers (reference impl) | Python, GCP |
| **Owns** | transport, OAuth, MCP↔verb translation, discovery caching | verbs, packs, SDK, packtest |
| **Holds** | the core credential + CF-Access service token | keys, grants policy, audit table |
| **Decides** | nothing governed | authorization, fail-closed |
| **Writes audit** | never | always |
| **Verifies identity token** | no (forwards it) | **yes** |

### 2.5 Naming, against the existing lexicon

Charter already says `engine`, `bridge`, `proxy`. To keep those from colliding:

- **The gateway replaces the stdio proxy outright.** `plugin/proxy/charter_mcp.js`
  is **deprecated and removed in the same release that ships the gateway** (§7.1)
  — there are no external adopters to migrate, so charter never carries two MCP
  adapters. One role, one implementation.
- `bridge` stays the name of core's HTTP entry function in code. "Core" is the
  deployable; "bridge" is its door.
- Deployable names stay plain and operator-legible. Charter's distinctive
  vocabulary is spent on *concepts* (`verbs`, `packs`, `actor`, `audit`, and now
  `grants` — §4.1), which is where it carries meaning a generic word would lose.
  "charter-gateway" tells a stranger what it is; a metaphorical name would make
  them read docs first. The brand payoff accrues to readers, the cost to
  operators — so concepts get the charter words, deployables get the boring ones.

## 3. Shape

```
  Today (interactive):                    Gateway + core (interactive):

  Claude client                           Claude client
     │ stdio                                 │ Streamable HTTP + OAuth 2.1
  charter_mcp.js  ← holds API key,        charter-gateway  ← OAuth provider
     │  CF creds, does Google OAuth          │  (federates Google), holds
     │                                       │  the core credential
     │ HTTPS + X-API-Key + X-Actor-Token     │ HTTPS + credential + X-Actor-Token
  core (Cloud Run, CF Access)             core (Cloud Run, CF Access)
                                             ▲ unchanged contract; caller now
                                               derived from identity (§4.1)
```

The credential and CF-Access service token stop being distributed to humans.
They live once, in the gateway. Humans hold only a Google session.

## 4. Locked decisions

### 4.1 Authorization is derived from identity, in core — **grants**

The gateway proves *who* the human is (forwards a verified Google ID token).
**Core** decides *what* they may do, from **grants** — the map of which verbs a
named person is granted. This is enforced in the same place as the API-key
allow-list today, so authorization stays inside the audited engine (§2.1).

*(A charter grants powers to named parties; the file is literally that. The name
is charter vocabulary because it carries meaning — see §2.5.)*

- New secret `charter-grants`: a JSON map
  `{ "jason@radicalcandor.com": {"allow": ["data.*", "content.*.draft*"]}, ... }`,
  read live from Secret Manager and cached exactly like `charter-keys`
  (`auth.py` pattern). The `allow` field name matches key records deliberately —
  one allow-list syntax, two ways of being identified. **Fail-closed:** an email
  with no grant gets no scope, so the caller is `None` → 401.
- `auth.identify(request)` is tried first (X-API-Key → headless path, unchanged).
  When it returns `None`, core tries a new `identify_by_actor(request)`:
  verify the `X-Actor-Token` (existing `actor_email()`), look up the email's
  grant, and synthesize a caller record `{"name": email, "interface": "oauth",
  "allow": <granted allow>, "require_actor": False}`. No valid token, or no
  grant → `None`.
- Both paths coexist. An API key still wins when present (headless keeps working
  and can still layer an actor on top). The require_actor gate is irrelevant on
  the OAuth path — the caller *is* the actor.

**Trust boundary (defense in depth):** CF Access = network gate (only the
gateway, holding the service token, can reach core). Google ID token = identity
(cryptographically verified **by core**; unforgeable by the gateway). Grants =
authorization (fail-closed). A stolen grants file confers nothing; it names
emails and verb patterns, not secrets.

### 4.2 The gateway is the proxy's translation, hosted

It exposes an MCP server over Streamable HTTP and translates `tools/call` → POST
`{"verb", ...args}` to core with the gateway-held credential + the caller's
Google ID token as `X-Actor-Token`. This is `charter_mcp.js`'s
`handle()`/`callBridge()` logic minus the local file tricks, plus OAuth and the
current transport requirements (§5).

The four-tool surface (`charter_call`, `charter_read`, `charter_login`,
`charter_connect_hubspot`) is inherited, minus `charter_login` — OAuth at install
replaces it. Verb discovery stays on-demand via `verbs.list`, so the constant
context cost that motivates charter is preserved.

### 4.3 OAuth model

Client-driven OAuth 2.1 (authorization code + PKCE), the MCP standard. The
gateway is an OAuth **resource server** advertising protected-resource metadata
(RFC 9728) and an **authorization server** that **federates Google** as the
upstream IdP (openid email) — the audience is the gateway, not Google. This is
the PostHog "sign in, we federate your provider" flow. No bespoke long-lived
credential is minted or written to disk (that was B-lite, rejected).

**Token passthrough is forbidden and we already comply.** The spec requires that
the token the gateway receives from the client is never forwarded upstream;
upstream calls use a separate credential the gateway holds as its own client.
That is exactly §4.4.

### 4.4 CF Access moves from human to gateway

Today every human's proxy carries a CF-Access service token. Now the public MCP
endpoint is protected by OAuth, and the **gateway** holds one CF-Access service
token to reach core over the existing tunnel. Net effect: CF Access on core is
**unchanged**; we simply stop hand-distributing its credentials.

### 4.5 Payload: the standard MCP pattern (reference in, resource-link out)

This is a **framework contract**, not a fix for RC's skills. The standard, as of
the stable spec (2025-11-25) and confirmed across six established remote servers
(GitHub, Notion, Linear, Sentry, Cloudflare, PostHog):

- **Large inputs go by reference, never by value.** Tool input is JSON-Schema
  only — no binary/file type. Every field-tested server takes an id / path / URI
  the server dereferences; none accept inline byte uploads. `roots` is deprecated,
  resource-as-input never existed. The draft **SEP-2631** formalizes exactly this
  (`authorizeUpload` → the tool arg stays a **file URI**, bytes move out-of-band).
- **Large outputs go by reference above a threshold.** Inline small results;
  return a `resource_link` past a `maxInlineBytes` limit (GitHub 1 MB, PostHog
  12k chars are the reference points). Typed results use
  `structuredContent`+`outputSchema`. Spec `nextCursor` pagination is for `*/list`
  only — a verb with an unbounded result set defines its own cursor.

**Charter's verb-authoring contract (goes in the SDK / pack-authoring skill):**

1. Inline what the **model authors** (small JSON). Pass large or pre-existing
   artifacts **by reference** (URI/id) and dereference inside the verb. No
   inline-base64 input field, ever. If charter later needs true client upload,
   mirror SEP-2631's `authorizeUpload → file URI` control-plane — don't invent an
   inline arg that has to be broken later.
2. Return typed `structuredContent`; above `maxInlineBytes`, return a reference,
   not bytes. On remote the **server side** holds the blob — there is no
   client-disk analog of today's `args_path`/`out_path`.

The client-side `args_path`/`out_path` tricks are **stdio-era**; they collapse
into reference-in / resource-link-out and are dropped for the gateway path.

**RC's three skills are just instances of the contract** (measured 2026-07-25,
real builders; no payload embeds binary — covers are URLs):

| payload | size | ~tokens | input is | contract |
|---|---|---|---|---|
| blog (`content.hs_post.draft`) | 15 KB | 3.8K | model-authored body | **inline** |
| email (`content.hs_email.draft`) | 25 KB | 6.3K | model-authored blocks | **inline** |
| podcast (45-min ep) | 63 KB | 16K | Drive transcript (pre-existing) | **by reference** |
| podcast (90-min ep) | ~120 KB | ~30K | Drive transcript | by reference |

The podcast verb takes the **Drive transcript reference** and dereferences +
assembles it (`build_post.py`'s `format_transcript` + glossary-link move into the
verb) — the idiomatic input pattern, not a special case. The model never holds or
reproduces the 60 KB body. The diagnostic contract is `structuredContent`:
`build_post.py` already emits `turns=110 glossary_links=2 body_bytes=61539` — the
verb returns those (plus a preview) instead of printing them.

`ponytail:` adopt the standard (reference-in, threshold-linked-out); no bespoke
blob store, no per-payload special cases.

### 4.6 The actor token across the seam (added 2026-07-25, planning B)

§4.1 says the gateway forwards "a verified Google ID token" and core verifies it.
Reading `actor_auth.py` while planning B surfaced three things that decision
implies but never stated. All three are locked here.

**Audience.** `actor_email()` verifies the token against
`settings.google_oauth_client_id` (`actor_auth.py:40-42`) — a strict `aud` check.
A token minted for the *proxy's* desktop client will not verify at core once the
gateway mints its own. **Decision:** core's `google_oauth_client_id` is repointed
to the gateway's Google **Web application** client, and the desktop client is
retired with the proxy in D. No multi-audience list: one gateway, one client.
`ponytail:` a list of accepted audiences is the thing to build when a second
gateway exists, not before. This makes B and D a single release — until D lands,
repointing breaks the proxy, which is acceptable only because there are no
adopters (§7.1).

**Freshness.** Google ID tokens live ~1 hour; an MCP session outlives that. The
gateway therefore requests `openid email` **with offline access**, keeps the
Google **refresh token** in the encrypted OAuth props that
`workers-oauth-provider` already persists, and re-mints an ID token when the
cached one is within a minute of `exp`. The client's own MCP token is unaffected
— it is the gateway's, on the gateway's lifetime. **Core still verifies Google
itself, so invariant 1 (§2.1) holds**: the gateway relays an unforgeable token,
it does not assert identity.

**`charter_connect_hubspot` cannot be ported as-is.** §4.2 said the surface is
"the four tools minus `charter_login`" — but the HubSpot connect tool is *also* a
local flow: it opens a loopback listener on `127.0.0.1:53682`
(`charter_mcp.js:36`, `HS_CONNECT_PORT`) and hands the resulting code to the
`identity.hs.connect` verb. A remote gateway has no loopback. It needs a second
federated OAuth flow, hosted at a gateway redirect URI. **Out of scope for B** —
B ships `charter_read` and `charter_call`, and the HubSpot connect is planned
separately once B's federation pattern is proven. Verbs that need a HubSpot
identity return `hs_identity_required` until then, exactly as they do today for
an unconnected user.

## 5. The gateway's reference implementation

**Decided: a Cloudflare Worker running a maintained MCP SDK, with OAuth from a
maintained library (`workers-oauth-provider`).**

The deciding factor is not the runtime — it's **whose code tracks the spec**.
Verified 2026-07-25: the **2026-07-28** revision is a *transport rewrite*, not a
point release.

**What the gateway must implement (2026-07-28):**

- **Stateless** — no `initialize` handshake, no `Mcp-Session-Id`; per-request
  `_meta` carries protocol version + client capabilities. Cross-call state uses
  server-minted handles passed as ordinary tool arguments.
- **Routable headers REQUIRED** — `Mcp-Method`, `Mcp-Name`,
  `MCP-Protocol-Version`, each validated against the body; mismatch → `400` +
  `-32020`.
- **`server/discover`** — new required RPC.
- **`resultType`** on every result; **`ttlMs` + `cacheScope`** on list/read
  results (`CacheableResult`).
- **MRTR** — servers may not send independent requests; server→client asks become
  `InputRequiredResult` + client retry.
- **Removed:** HTTP GET endpoint (`405`), SSE resumability/`Last-Event-ID`,
  `ping`, `logging/setLevel`. `resources/subscribe` → `subscriptions/listen`.
- **Dual-era comes free from the SDK** — ~~Modern↔Legacy fails in *both*
  directions~~. Corrected 2026-07-25 against the SDK-beta announcement: both
  directions negotiate automatically. "A v2 server answers the legacy
  `initialize` handshake alongside `server/discover`, so clients on `2025-11-25`
  keep connecting," and "clients that speak `2026-07-28` fall back to the
  `initialize` handshake when they reach a server on `2025-11-25` or earlier."
  Dual-era is a property of the SDK, not engineering charter has to do.
- **Auth is the stable part** — RFC 9728 PRM, RFC 8707 audience validation, PKCE
  `S256`, and the no-token-passthrough rule all carry over unchanged. New:
  publish `code_challenge_methods_supported`; RFC 9207 `iss` (SHOULD); DCR
  deprecated in favor of Client ID Metadata Documents (SHOULD).

None of that is charter's business logic. Hand-rolling it in Python would mean
owning a dual-era transport rewrite against a days-old spec, on top of an OAuth
authorization server — the exact sensitive surface we set out to avoid.

**Rejected alternatives.** *Extend the Python core* with MCP + OAuth endpoints:
one deployable, no new runtime, but hand-rolls the two hardest and
fastest-moving pieces. *Managed vendor* (WorkOS AuthKit / Stytch): offloads OAuth
entirely but adds an external identity dependency and per-seat cost; over-scoped
for single tenant.

**This choice is scoped to the reference implementation** (§2.2) — it is not a
requirement charter imposes on adopters, and it does not affect core.

**The 2026-07-28 date is a publication date, not a gate.** The release candidate
has been *locked since 2026-05-21*; July 28 is when the final text publishes.
Beta SDKs shipped against the locked RC — TypeScript v2 is two new packages,
`@modelcontextprotocol/server` and `@modelcontextprotocol/client`, both at
`2.0.0-beta.1` (the v1 `@modelcontextprotocol/sdk` package stays on v1). Serving
`2026-07-28` is opt-in at the transport wiring, not a side effect of upgrading.
So B is not blocked on a freeze — re-diff the published changelog when it lands,
but build before it.

**Which revision B ships on — the real question, and it is not ours to force.**
Cloudflare's `agents` stack (`createMcpHandler`, `OAuthProvider`) documents the
v1 MCP SDK (`McpServer`, "since 1.26.0"); as of 2026-07-25 there is no published
evidence it accepts the v2 split packages. Since dual-era negotiation is
automatic in *both* directions (above), shipping B on **2025-11-25** costs
nothing: `2026-07-28` clients fall back and keep working. So B targets whatever
revision the Cloudflare stack speaks on the day it is built, and the
`2026-07-28` surface (`server/discover`, routable headers, `resultType`,
`ttlMs`/`cacheScope`, MRTR) arrives with the SDK upgrade rather than being
hand-rolled. `ponytail:` let the SDK own the transport era; that was the whole
reason for choosing a maintained SDK in §5.

**Stateless, no Durable Object.** `createMcpHandler` serves MCP from a plain
Worker; `McpAgent` (a Durable Object per session) is only needed for per-session
state or legacy SSE, and the gateway has neither — it holds one credential and
translates. Construct a fresh `McpServer` per request (SDK ≥1.26.0 guards
against reconnecting one).

## 6. Sub-projects

Broken per the writing-plans scope check; each ships and tests on its own.

| | Sub-project | Depends on | Detailed plan |
|---|---|---|---|
| **A** | **Core: grants** — `identify_by_actor` + grants loader, fail-closed | nothing | **written** (`plans/2026-07-25-remote-mcp-grants.md`) |
| **B** | **Gateway** — MCP over Streamable HTTP + OAuth federating Google; translates to core. Ships on whichever revision the SDK speaks; dual-era is automatic (§5) | A ✓, §5 ✓ | next |
| **C** | **Payload contract** — adopt reference-in / resource-link-out (§4.5); inline blog+email, podcast takes a Drive reference; document in the pack-authoring skill | measurement ✓ | scoped by §4.5 |
| **D** | **Distribution repackage + proxy removal** — plugin becomes a remote-HTTP pointer (`{"type":"http"}`) carrying skills; **delete** `plugin/proxy/` and `desktop-extension/`; update `INSTALL.md`/`distribution.md` | B | after B works |

**Seam A↔B:** core accepts a caller derived from `X-Actor-Token` + grants,
reached only through the CF-Access-gated tunnel. The
gateway's only contract with core is "present a valid Google ID token + the
gateway credential." Core verifies the token itself (§2.1).

**Sequencing:** A is shippable now and de-risks everything (it's the auth model),
and it is pure core work — unaffected by any MCP spec churn. **A landed
2026-07-25.** Then B — *not* gated on 2026-07-28, which is a publication date
against an RC locked since 2026-05-21 (§5). D follows B.

**C splits, and only half of it waits.** The table's "depends on: measurement ✓"
and the old "C and D follow B" disagreed; the resolution is that C is two
contracts. *Reference-in* (large args by URI/id, dereferenced inside the verb)
is core- and pack-side, independent of the gateway, and shippable alongside or
before B. *Resource-link-out* is emitted in MCP content blocks by the gateway, so
that half needs B. Split C when it is planned.

## 7. Deprecation and non-goals

### 7.1 The stdio proxy is deprecated in this release

No external adopters exist as of 2026-07-25, so there is no migration burden and
no reason to maintain two MCP adapters. `plugin/proxy/charter_mcp.js` and the
`.mcpb` desktop extension are **removed in the release that ships the gateway**,
not soft-deprecated. Sub-project D carries the removal.

**Headless agents are still unchanged, and don't need the proxy.** CI/cron keep
admin-minted `charter keys mint` keys and the `X-API-Key` path — but they reach
**core's HTTP API directly**, which is already how `packtest`, the curl
verification in `INSTALL.md`, and any script talk to it. MCP was only ever the
adapter for *Claude clients*; a cron job doesn't need one.

**Open, small:** if a *headless Claude agent* (e.g. Claude Code in CI) ever needs
MCP without a human OAuth flow, the gateway should accept a bearer API key as an
alternative to an OAuth token and forward it as `X-API-Key` — core already
accepts both. `ponytail:` don't build it until something actually needs it.

### 7.2 Non-goals
- **No cross-tenant.** Single operator, single org (see `distribution.md`).
- **No rewrite of core to TS/Workers.** Charter's extension point is Python packs
  (`charter.sdk`, `packtest`) and its audit/keys are GCP-coupled; moving core
  would discard the pack ecosystem. The gateway split exists precisely so it
  doesn't have to move.
- **No blob store / return-by-reference apparatus** beyond §4.5's standard.
- **No vendor requirement on adopters** — §2.2.

## Sources

- Payload pattern (verified 2026-07-25): stable spec [MCP 2025-11-25 — Tools,
  Resources, Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/tools);
  no in-spec upload channel (input is JSON-Schema-only, no binary type). Draft
  [SEP-2631 File Objects & Transfer](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631)
  is the proposal that will add `authorizeUpload → file URI` — **draft, not in the
  2026-07-28 revision**; do not plan around it. `roots` deprecated by SEP-2577 in
  2026-07-28 (that SEP number is correct; it was only ever mis-*described* here as
  a large-payload finding), whose migration guidance — pass files "via tool
  parameters, resource URIs, or server configuration" — is this same pattern.
  Field practice (inputs by id/URI; outputs via `resource_link` past a size
  threshold): GitHub (1 MB), PostHog (12k-char spill), Notion/Linear/Sentry
  (cursor pagination).
- 2026-07-28 revision (verified 2026-07-25):
  [Key Changes / changelog](https://modelcontextprotocol.io/specification/draft/changelog)
  is authoritative; stateless SEP-2567/2575, routable headers SEP-2243, MRTR
  SEP-2322, schemas SEP-2106, CacheableResult SEP-2549, deprecations SEP-2577.
  Authorization requirements:
  [draft/basic/authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization).
- OAuth model: PostHog plugin as the reference shape
  (`.mcp.json` `{"type":"http", "url":"https://mcp.posthog.com/mcp"}` + OAuth).
- Dual-era, SDK betas, and the RC lock date (verified 2026-07-25):
  [Beta SDKs for the 2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)
  (split packages `@modelcontextprotocol/server` / `client` at `2.0.0-beta.1`;
  opt-in at the transport; automatic negotiation in both directions) and
  [The 2026-07-28 Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
  ("The release candidate is locked as of May 21, 2026. The final specification
  will be published on July 28, 2026."). **This corrects the earlier
  "Modern↔Legacy fails in both directions" claim in §5.**
- Cloudflare gateway shape (verified 2026-07-25):
  [`createMcpHandler` API reference](https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/)
  (stateless, plain Worker, no Durable Object; fresh `McpServer` per request
  since SDK 1.26.0) and
  [Authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)
  (`OAuthProvider` with `apiRoute`/`apiHandler`/`defaultHandler` +
  `authorizeEndpoint`/`tokenEndpoint`/`clientRegistrationEndpoint`; third-party
  IdP federation is the documented Google path; tools read the caller via
  `getMcpAuthContext()`).
- Current engine: `src/charter/main.py`, `auth.py`, `actor_auth.py`,
  `settings.py`; proxy `plugin/proxy/charter_mcp.js`.
