import { describe, expect, it } from "vitest";
import { authHeaders, callCore, type CoreConfig } from "../src/core.js";

const CFG: CoreConfig = {
  url: "https://core.example.com",
  cfAccessClientId: "cfid",
  cfAccessClientSecret: "cfsecret",
};

/** A deploy that also holds an API key, for the headless-shaped call. */
const CFG_WITH_KEY: CoreConfig = { ...CFG, apiKey: "apikey" };

/** Minimal fetch double: records the request, returns a canned response. */
function fakeFetch(status: number, body: string) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("authHeaders", () => {
  // The load-bearing one. Core resolves X-API-Key before the actor+grants path,
  // so a key sent beside an actor token silently authorizes every signed-in
  // human as the gateway. If this test ever goes green with both headers
  // present, grants are dead config (spec §2.1, §4.1).
  it("never sends an API key alongside an actor token", () => {
    const h = authHeaders(CFG_WITH_KEY, "idtok");
    expect(h["X-Actor-Token"]).toBe("idtok");
    expect("X-API-Key" in h).toBe(false);
  });

  it("sends the API key when there is no actor token", () => {
    const h = authHeaders(CFG_WITH_KEY);
    expect(h["X-API-Key"]).toBe("apikey");
    expect("X-Actor-Token" in h).toBe(false);
  });

  it("always sends the CF Access service token — it is the network gate, not scope", () => {
    for (const h of [authHeaders(CFG_WITH_KEY, "idtok"), authHeaders(CFG_WITH_KEY)]) {
      expect(h["CF-Access-Client-Id"]).toBe("cfid");
      expect(h["CF-Access-Client-Secret"]).toBe("cfsecret");
    }
  });

  it("omits unset headers rather than sending empty ones", () => {
    expect(authHeaders({ url: "https://core.example.com", cfAccessClientId: "", cfAccessClientSecret: "" })).toEqual({});
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

  it("sends the CF Access token and the actor token, and no API key", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await callCore(impl, CFG_WITH_KEY, "verbs.list", {}, { actorToken: "idtok" });
    const h = seen[0].init.headers as Record<string, string>;
    expect(h["CF-Access-Client-Id"]).toBe("cfid");
    expect(h["X-Actor-Token"]).toBe("idtok");
    expect("X-API-Key" in h).toBe(false);
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("omits X-Actor-Token entirely when there is no actor", async () => {
    const { impl, seen } = fakeFetch(200, "{}");
    await callCore(impl, CFG, "verbs.list", {}, {});
    expect("X-Actor-Token" in (seen[0].init.headers as object)).toBe(false);
  });

  // SEP-414: `traceparent` rides in the client's `_meta` and is forwarded so
  // core's audit row joins the caller's trace. It is caller-controlled, so the
  // shape check matters more than the happy path.
  describe("traceparent forwarding", () => {
    const GOOD = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    async function headersFor(traceparent?: string) {
      const { impl, seen } = fakeFetch(200, "{}");
      await callCore(impl, CFG, "v", {}, { traceparent });
      return seen[0].init.headers as Record<string, string>;
    }

    it("forwards a well-formed traceparent", async () => {
      expect((await headersFor(GOOD)).traceparent).toBe(GOOD);
    });

    it("sends no header when there is no traceparent", async () => {
      expect((await headersFor()).traceparent).toBeUndefined();
    });

    it("drops anything that is not a version-00 traceparent", async () => {
      const bad = [
        "garbage",
        // Header injection: a raw CRLF here is what fetch() throws on.
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\nX-API-Key: stolen",
        // All-zero trace id and all-zero span id are invalid per the W3C spec.
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        // Right shape, wrong lengths / non-hex / unsupported version.
        "00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01",
        "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        ` ${GOOD}`,
        `${GOOD} `,
      ];
      for (const value of bad) {
        expect((await headersFor(value)).traceparent, value).toBeUndefined();
      }
    });
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

  it("truncates a response larger than the inline cap and reports it as an error (X3)", async () => {
    // Truncated JSON is unparseable; a 2xx would tell the model it succeeded
    // anyway, the exact behavior docs/remote-mcp.md §4.5 argues against.
    const big = "x".repeat(1024 * 1024 + 10);
    const { impl } = fakeFetch(200, big);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(true);
    expect(r.text.length).toBeLessThan(big.length);
    expect(r.text.endsWith("\n...[truncated]")).toBe(true);
  });

  const CAP_BYTES = 1024 * 1024;

  it("truncates a response whose byte length exceeds the cap, staying within it in bytes", async () => {
    const big = "x".repeat(CAP_BYTES + 10);
    const { impl } = fakeFetch(200, big);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(true);
    expect(r.text.endsWith("\n...[truncated]")).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(CAP_BYTES);
  });

  it("caps a multi-byte UTF-8 body by bytes, not characters, without throwing", async () => {
    // Each "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit — a char-length cap
    // would let a body like this run to ~2x the byte cap before truncating.
    const big = "é".repeat(CAP_BYTES);
    const { impl } = fakeFetch(200, big);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(true);
    expect(r.text.endsWith("\n...[truncated]")).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(CAP_BYTES);
    // At most the final cut character decodes to a replacement char — no mess.
    expect((r.text.match(/�/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("does not truncate a body exactly at the cap", async () => {
    const exact = "x".repeat(CAP_BYTES);
    const { impl } = fakeFetch(200, exact);
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r).toEqual({ text: exact, isError: false });
  });

  it("handles an empty body", async () => {
    const { impl } = fakeFetch(200, "");
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r).toEqual({ text: "", isError: false });
  });

  it("returns an error, not a throw, when the network fails", async () => {
    const impl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const r = await callCore(impl, CFG, "verbs.list", {}, {});
    expect(r.isError).toBe(true);
    expect(r.text).toBe("request failed: connection reset");
  });

  it("never leaks a credential into an error message", async () => {
    const impl = (async () => {
      throw new Error("boom cfid:cfsecret:apikey");
    }) as unknown as typeof fetch;
    const r = await callCore(impl, CFG_WITH_KEY, "verbs.list", {}, {});
    expect(r.text).not.toContain("apikey");
    expect(r.text).not.toContain("cfsecret");
  });

  // S4: scrub() used to run only on the failure/non-2xx paths. If core ever
  // echoed a request header (or anything credential-shaped) into a 200 body,
  // the byte cap was the only control on that path — the credential would
  // otherwise land verbatim in the model's context.
  it("redacts a credential that leaks into a successful response body (S4)", async () => {
    const { impl } = fakeFetch(200, '{"echo":"cfsecret and apikey leaked"}');
    const r = await callCore(impl, CFG_WITH_KEY, "verbs.list", {}, {});
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("cfsecret");
    expect(r.text).not.toContain("apikey");
  });

  // R1: redaction used to run AFTER readCapped's byte cut. A credential
  // straddling that cut was sliced in half, and redact() — which matches whole
  // strings — had nothing left to match, so the leading fragment reached the
  // model verbatim on an ordinary 200. Sweeping the cut one byte at a time is
  // the whole point of this test: any single-position version passes by luck,
  // because most positions leak and a few (a fragment under redact()'s 4-char
  // floor, or the cut landing past the secret entirely) do not.
  it("redacts a credential straddling the truncation cut at every offset (R1)", async () => {
    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz";
    const cfg: CoreConfig = { ...CFG, cfAccessClientSecret: secret };
    // Where core.ts cuts: the cap, less the truncation suffix and the
    // worst-case UTF-8 replacement slack (TRUNCATE_BUDGET_BYTES).
    const CUT = CAP_BYTES - "\n...[truncated]".length - 2;
    const REDACTED = "[redacted]";

    for (let i = 0; i <= secret.length; i++) {
      // Place the secret so the cut falls exactly i bytes into it.
      const body = "x".repeat(CUT - i) + secret + "y".repeat(CAP_BYTES);
      const { impl } = fakeFetch(200, body);
      const r = await callCore(impl, cfg, "verbs.list", {}, {});

      expect(r.isError).toBe(true); // i.e. this response really was truncated
      // Only a *leading* fragment can survive the cut, so every fragment
      // redact() would have matched (>= 4 chars) starts with these four.
      expect(r.text.includes(secret.slice(0, 4))).toBe(false);
      // Not vacuous: once the cut is past where "[redacted]" ends, the
      // replacement itself has to be visible in the output.
      if (i >= REDACTED.length) expect(r.text).toContain(REDACTED);
    }
  });
});

describe("callCore maxBytes override", () => {
  it("caps at opts.maxBytes and reports truncation as an error", async () => {
    const { impl } = fakeFetch(200, "a".repeat(5000));
    const r = await callCore(impl, CFG, "v.x", {}, { actorToken: "t", maxBytes: 1024 });
    expect(r.isError).toBe(true);
    expect(r.text.endsWith("...[truncated]")).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(1024);
  });

  it("passes a body under opts.maxBytes through untouched", async () => {
    const { impl } = fakeFetch(200, "a".repeat(2000));
    const r = await callCore(impl, CFG, "v.x", {}, { actorToken: "t", maxBytes: 4096 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("a".repeat(2000));
  });

  it("redacts a secret straddling the override cut (ordering invariant)", async () => {
    const secret = "SECRETSECRETSECRETSECRET";
    const body = "a".repeat(1024 - 10) + secret + "b".repeat(200);
    const { impl } = fakeFetch(200, body);
    const c = { ...CFG, cfAccessClientSecret: secret };
    const r = await callCore(impl, c, "v.x", {}, { actorToken: "t", maxBytes: 1024 });
    expect(r.text).not.toContain(secret.slice(0, 10)); // no unmatched half survives
  });
});
