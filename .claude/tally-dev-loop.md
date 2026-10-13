# dev loop
routing: on

## Lenses
- correctness: attack verb dispatch, grant/permission checks, and error/result paths; p1 = a verb runs without its required grant, or an executed verb produces a missing or wrong audit row
- security: attack the gateway OAuth flow, API-key/actor auth, secret handling, and input parsing at the MCP boundary; p1 = auth bypass, actor spoofing, or secret leakage
- invariants: guard documented contracts — stateless gateway (no cross-call session state), two-tool MCP surface, audit schema stability, engine stays provider-agnostic (provider code lives in packs); p1 = any break
- simplicity: flag over-engineering; findings cap at p2; deliberate generalization is on purpose in this repo and is not a finding
