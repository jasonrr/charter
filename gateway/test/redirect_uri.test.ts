import { describe, expect, it } from "vitest";
import {
  classifyRedirectUri,
  parseExtraOrigins,
  screenRedirectUris,
} from "../src/redirect_uri.js";
import { escapeHtml } from "../src/html.js";

const GW = "https://gateway.example.com";
const ok = (uri: unknown, extra: string[] = []) =>
  classifyRedirectUri(uri, GW, extra).allowed;

describe("classifyRedirectUri — accepted", () => {
  it.each([
    "http://localhost/callback",
    "http://localhost:8080/callback",
    "http://localhost:33418/",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:33418/",
    "http://[::1]:1234/cb",
    "https://localhost:8443/cb",
    // A loopback URI can only be collected on the victim's own machine, so the
    // path and query on it are not our problem.
    "http://127.0.0.1:9999/oauth/callback?x=1#frag",
  ])("accepts loopback %s", (uri) => {
    expect(ok(uri)).toBe(true);
  });

  it("accepts an https URI on the gateway's own origin", () => {
    expect(ok(`${GW}/callback`)).toBe(true);
  });

  it("accepts an operator-configured extra origin", () => {
    expect(ok("https://vscode.dev/redirect", ["https://vscode.dev"])).toBe(true);
  });
});

describe("classifyRedirectUri — rejected", () => {
  it("rejects an arbitrary public https URI", () => {
    const v = classifyRedirectUri("https://attacker.example/collect", GW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/loopback/);
  });

  it.each([
    ["host merely contains localhost", "http://localhost.evil.example/cb"],
    ["host merely ends with the loopback ip", "http://127.0.0.1.evil.example/cb"],
    ["loopback as a subdomain label", "https://evil.example/localhost"],
    ["a different loopback-ish ip", "http://127.0.0.2/cb"],
    ["0.0.0.0 is not loopback", "http://0.0.0.0:8080/cb"],
    ["plain http on a public host", "http://attacker.example/cb"],
  ])("rejects %s", (_label, uri) => {
    expect(ok(uri)).toBe(false);
  });

  it("rejects userinfo smuggling a loopback host", () => {
    // Hostname here is evil.example; "localhost" is only the username.
    const v = classifyRedirectUri("https://localhost@evil.example/cb", GW);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/username or password/);
    expect(ok("https://user:pw@evil.example/cb")).toBe(false);
    // Even on a host that would otherwise pass.
    expect(ok("http://a@localhost:8080/cb")).toBe(false);
  });

  it("resolves percent-encoded and unicode hosts before deciding", () => {
    // %6c is "l" — this is really localhost, and must be judged as localhost
    // rather than as the literal string.
    expect(ok("http://%6cocalhost:8080/cb")).toBe(true);
    // A unicode look-alike is NOT localhost and must not pass.
    expect(ok("http://locaĺhost:8080/cb")).toBe(false);
  });

  it.each([
    ["a relative path", "/callback"],
    ["a bare host", "gateway.example.com/cb"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s without throwing", (_label, uri) => {
    expect(ok(uri)).toBe(false);
  });

  it("rejects a custom scheme even on loopback", () => {
    expect(ok("myapp://localhost/cb")).toBe(false);
    expect(ok("javascript:alert(1)")).toBe(false);
    expect(ok("data:text/html,x")).toBe(false);
  });

  it("does not accept the gateway origin over plain http", () => {
    expect(ok("http://gateway.example.com/callback")).toBe(false);
  });

  it("matches the extra origin exactly, not as a prefix", () => {
    const extra = ["https://vscode.dev"];
    expect(ok("https://vscode.dev.evil.example/cb", extra)).toBe(false);
    expect(ok("https://notvscode.dev/cb", extra)).toBe(false);
  });
});

describe("screenRedirectUris", () => {
  it("keeps the loopback entries of a mixed array and drops the rest", () => {
    // This is VS Code's real DCR payload shape.
    const r = screenRedirectUris(
      [
        "https://insiders.vscode.dev/redirect",
        "https://vscode.dev/redirect",
        "http://127.0.0.1/",
        "http://127.0.0.1:33418/",
      ],
      GW,
    );
    expect(r.accepted).toEqual(["http://127.0.0.1/", "http://127.0.0.1:33418/"]);
    expect(r.rejected.map((x) => x.uri)).toEqual([
      "https://insiders.vscode.dev/redirect",
      "https://vscode.dev/redirect",
    ]);
  });

  it("accepts every entry once the operator allows the origin", () => {
    const r = screenRedirectUris(
      ["https://vscode.dev/redirect", "http://127.0.0.1:33418/"],
      GW,
      ["https://vscode.dev"],
    );
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(2);
  });

  it("accepts nothing when every entry is public", () => {
    const r = screenRedirectUris(["https://attacker.example/collect"], GW);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it("returns empty for a non-array without throwing", () => {
    for (const bad of [undefined, null, "x", 5, {}]) {
      expect(screenRedirectUris(bad, GW)).toEqual({ accepted: [], rejected: [] });
    }
  });
});

describe("parseExtraOrigins", () => {
  it("splits, trims and normalises to origins", () => {
    expect(parseExtraOrigins(" https://a.example/x , https://b.example ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("is empty for unset or blank config", () => {
    expect(parseExtraOrigins(undefined)).toEqual([]);
    expect(parseExtraOrigins("")).toEqual([]);
    expect(parseExtraOrigins(" , ")).toEqual([]);
  });

  it("drops unparseable entries rather than throwing", () => {
    expect(parseExtraOrigins("not a url, https://ok.example")).toEqual([
      "https://ok.example",
    ]);
  });
});

describe("escapeHtml", () => {
  it("neutralises a tag-closing origin", () => {
    expect(escapeHtml('https://x/"><script>alert(1)</script>')).toBe(
      "https://x/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes both quote styles so it is safe in an attribute", () => {
    expect(escapeHtml(`a"b'c`)).toBe("a&quot;b&#39;c");
  });

  it("escapes ampersands first, not twice", () => {
    expect(escapeHtml("a&lt;b")).toBe("a&amp;lt;b");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("https://vscode.dev")).toBe("https://vscode.dev");
  });
});
