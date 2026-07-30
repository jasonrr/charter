import { describe, expect, it } from "vitest";
import {
  callbackUri,
  connectCall,
  handoffPage,
  isConnectState,
  parseConnectPath,
  parseProviders,
  upstreamAuthorizeUrl,
  type ConnectProvider,
} from "../src/connect.js";

const HS: ConnectProvider = {
  authorize_url: "https://app.hubspot.com/oauth/authorize",
  client_id: "cid-123",
  scopes: "oauth content files",
  verb: "identity.hs.connect",
  label: "hs",
};

/** The config shape an operator writes (no label — it defaults to the id). */
const HS_CONFIG = {
  authorize_url: HS.authorize_url,
  client_id: HS.client_id,
  scopes: HS.scopes,
  verb: HS.verb,
};

const TABLE = JSON.stringify({ hs: HS_CONFIG });

/** Undo escapeHtml, so a test can assert on what actually reaches the clipboard. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The copyable payload from the page's <pre>, entity-decoded. */
function pastedCall(html: string): string {
  const m = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  if (!m) throw new Error("no <pre> in page");
  return decodeEntities(m[1]);
}

describe("parseConnectPath", () => {
  it("splits the start route from the callback route", () => {
    expect(parseConnectPath("/connect/hs")).toEqual({ id: "hs", isCallback: false });
    expect(parseConnectPath("/connect/hs/callback")).toEqual({ id: "hs", isCallback: true });
  });

  it("matches nothing else", () => {
    for (const p of [
      "/connect",
      "/connect/",
      "/connect/hs/",
      "/connect/hs/callback/extra",
      "/callback",
      "/connect/hs/../callback",
      "/connect/a.b",
      `/connect/${"x".repeat(33)}`,
    ]) {
      expect(parseConnectPath(p), p).toBeNull();
    }
  });
});

describe("parseProviders", () => {
  it("reads a well-formed table, defaulting label to the id", () => {
    expect(parseProviders(TABLE).providers.hs).toEqual(HS);
  });

  it("accepts an already-parsed object, not just a JSON string", () => {
    expect(parseProviders({ hs: HS_CONFIG }).providers.hs).toEqual(HS);
  });

  it("keeps an explicit label", () => {
    const t = parseProviders({ hs: { ...HS_CONFIG, label: "HubSpot" } });
    expect(t.providers.hs.label).toBe("HubSpot");
  });

  it("is empty for unset and empty input, with no parse error", () => {
    for (const raw of [undefined, null, ""]) {
      const t = parseProviders(raw);
      expect(t.providers).toEqual({});
      expect(t.parseError).toBeUndefined();
    }
  });

  it("names the failure for input that is not a usable table", () => {
    expect(parseProviders("{").parseError).toBe("not valid JSON");
    expect(parseProviders("[]").parseError).toBe("not a JSON object");
    expect(parseProviders('"hs"').parseError).toBe("not a JSON object");
    expect(parseProviders("null").parseError).toBe("not a JSON object");
  });

  it("names the field that disqualified an entry instead of dropping it silently", () => {
    const cases: [unknown, string][] = [
      [{ ...HS_CONFIG, client_id: "" }, "client_id"],
      [{ ...HS_CONFIG, verb: "" }, "verb"],
      [{ ...HS_CONFIG, authorize_url: "http://app.hubspot.com/x" }, "authorize_url"],
      [{ ...HS_CONFIG, scopes: 42 }, "scopes"],
      // Rejected rather than dropped: a typo here silently disables the RFC 9207
      // check the operator was trying to switch on.
      [{ ...HS_CONFIG, issuer: "app.hubspot.com" }, "issuer"],
      [{ ...HS_CONFIG, issuer: 42 }, "issuer"],
      ["not-an-object", "not an object"],
    ];
    for (const [bad, reason] of cases) {
      const t = parseProviders({ hs: bad });
      expect(t.providers.hs, JSON.stringify(bad)).toBeUndefined();
      expect(t.rejected.hs, JSON.stringify(bad)).toBe(reason);
    }
  });

  it("carries an issuer through when set, and omits it when not", () => {
    const t = parseProviders({
      with: { ...HS_CONFIG, issuer: "https://app.hubspot.com" },
      without: HS_CONFIG,
    });
    expect(t.providers.with.issuer).toBe("https://app.hubspot.com");
    expect(t.providers.without.issuer).toBeUndefined();
  });

  it("keeps the good entries alongside a bad one", () => {
    const t = parseProviders({ hs: HS_CONFIG, broken: { ...HS_CONFIG, client_id: "" } });
    expect(Object.keys(t.providers)).toEqual(["hs"]);
    expect(t.rejected.broken).toBe("client_id");
  });

  it("builds a null-prototype table so an inherited key cannot pose as a provider", () => {
    // With a plain object literal, table["constructor"] is the Object function —
    // truthy — and the route's `if (!provider) 404` sails past it into building
    // a URL from undefined: an uncaught 500 on an unauthenticated path.
    const t = parseProviders(TABLE);
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(t.providers[key], key).toBeUndefined();
      expect(t.rejected[key], key).toBeUndefined();
    }
  });

  it("treats a __proto__ config key as data, not as the prototype setter", () => {
    const t = parseProviders('{"__proto__": {"authorize_url": "https://x.example/a", "client_id": "c", "scopes": "", "verb": "v"}}');
    expect(({} as Record<string, unknown>).authorize_url).toBeUndefined();
    expect(t.providers.__proto__?.client_id).toBe("c");
  });

  describe("authorize_params", () => {
    it("carries upstream-specific params (Google needs these for a refresh token)", () => {
      const t = parseProviders({
        g: { ...HS_CONFIG, authorize_params: { access_type: "offline", prompt: "consent" } },
      });
      expect(t.providers.g.authorize_params).toEqual({
        access_type: "offline",
        prompt: "consent",
      });
    });

    it("refuses a param this module owns", () => {
      for (const k of ["client_id", "redirect_uri", "scope", "state", "response_type"]) {
        const t = parseProviders({ g: { ...HS_CONFIG, authorize_params: { [k]: "x" } } });
        expect(t.rejected.g, k).toBe(`authorize_params.${k}`);
      }
    });

    it("refuses a non-string value and a non-object block", () => {
      expect(parseProviders({ g: { ...HS_CONFIG, authorize_params: { a: 1 } } }).rejected.g)
        .toBe("authorize_params.a");
      expect(parseProviders({ g: { ...HS_CONFIG, authorize_params: "x" } }).rejected.g)
        .toBe("authorize_params");
    });
  });
});

describe("callbackUri", () => {
  it("resolves against the configured origin", () => {
    expect(callbackUri("https://gw.example.com", "hs")).toBe(
      "https://gw.example.com/connect/hs/callback",
    );
    expect(callbackUri("https://gw.example.com/", "hs")).toBe(
      "https://gw.example.com/connect/hs/callback",
    );
  });

  it("ignores a path on CHARTER_GATEWAY_URL rather than emitting an unroutable URI", () => {
    // gatewayUrlProblem only compares .origin, so a configured path passes every
    // gate. Concatenating would send the upstream's code to /base/connect/... —
    // a path parseConnectPath never matches, i.e. a 404 with no operator signal.
    expect(callbackUri("https://gw.example.com/base", "hs")).toBe(
      "https://gw.example.com/connect/hs/callback",
    );
  });
});

describe("upstreamAuthorizeUrl", () => {
  const build = (p: ConnectProvider = HS) =>
    new URL(upstreamAuthorizeUrl(p, "https://gw.example.com/connect/hs/callback", "st.8"));

  it("carries client id, redirect, scopes and state", () => {
    const u = build();
    expect(u.origin + u.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid-123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://gw.example.com/connect/hs/callback");
    expect(u.searchParams.get("scope")).toBe("oauth content files");
    expect(u.searchParams.get("state")).toBe("st.8");
  });

  it("sets response_type=code, which RFC 6749 requires", () => {
    // HubSpot tolerates its absence; Google, GitHub, Entra and Slack do not.
    expect(build().searchParams.get("response_type")).toBe("code");
  });

  it("omits scope entirely when the provider declares none", () => {
    expect(build({ ...HS, scopes: "" }).searchParams.has("scope")).toBe(false);
  });

  it("appends provider-specific params", () => {
    const u = build({ ...HS, authorize_params: { access_type: "offline" } });
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("response_type")).toBe("code");
  });
});

describe("isConnectState", () => {
  it("accepts only a state sealed for this provider", () => {
    expect(isConnectState({ p: "hs" }, "hs")).toBe(true);
    expect(isConnectState({ p: "other" }, "hs")).toBe(false);
    // a sign-in state (an AuthRequest) replayed at a connect callback
    expect(isConnectState({ clientId: "abc", redirectUri: "https://c/cb" }, "hs")).toBe(false);
    expect(isConnectState(null, "hs")).toBe(false);
    expect(isConnectState("hs", "hs")).toBe(false);
  });
});

describe("connectCall", () => {
  it("is the wire contract: verb plus code and redirect_uri", () => {
    expect(connectCall(HS, "abc", "https://gw.example.com/connect/hs/callback")).toEqual({
      verb: "identity.hs.connect",
      args: { code: "abc", redirect_uri: "https://gw.example.com/connect/hs/callback" },
    });
  });
});

describe("handoffPage", () => {
  const REDIRECT = "https://gw.example.com/connect/hs/callback";
  const render = (code: string) => handoffPage(HS, code, REDIRECT, "charter_call");

  it("names the tool the client actually exposes, not just the verb", () => {
    // identity.hs.connect is a write verb; an agent reaching for charter_read
    // gets write_in_read_tool and burns a round trip on the last step.
    expect(pastedCall(render("abc-123")).startsWith("charter_call ")).toBe(true);
  });

  it("round-trips a code containing JSON metacharacters", () => {
    // RFC 6749 permits " and \ in a code. Interpolating into a JSON-shaped
    // template would let whoever supplies the code choose FIELDS of the call.
    const hostile = 'a", "portal_id": "999';
    const parsed = JSON.parse(pastedCall(render(hostile)).replace(/^charter_call /, ""));
    expect(parsed.args.code).toBe(hostile);
    expect(parsed.args).toEqual({ code: hostile, redirect_uri: REDIRECT });
    expect(parsed.verb).toBe("identity.hs.connect");
  });

  it("round-trips a code containing a backslash", () => {
    const parsed = JSON.parse(pastedCall(render("a\\b")).replace(/^charter_call /, ""));
    expect(parsed.args.code).toBe("a\\b");
  });

  it("escapes an upstream code so it cannot close a tag", () => {
    const html = render('"><script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a label that came from config", () => {
    const html = handoffPage({ ...HS, label: "<b>HubSpot</b>" }, "c", REDIRECT, "charter_call");
    expect(html).not.toContain("<b>HubSpot</b>");
  });
});
