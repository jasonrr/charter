import { describe, expect, it } from "vitest";
import { gatewayOrigin, gatewayUrlProblem } from "../src/gateway_url.js";

const CANON = "https://charter.example.com";

describe("gatewayOrigin", () => {
  it("reduces a configured URL to its origin", () => {
    expect(gatewayOrigin("https://charter.example.com/some/path")).toBe(CANON);
  });

  it("is empty for unset, unparseable, or non-https values", () => {
    for (const bad of [undefined, "", "not a url", "http://charter.example.com"]) {
      expect(gatewayOrigin(bad)).toBe("");
    }
  });
});

describe("gatewayUrlProblem", () => {
  it("passes when the request arrived on the configured origin", () => {
    expect(gatewayUrlProblem(CANON, `${CANON}/authorize?x=1`)).toBeNull();
  });

  it("names an unset value", () => {
    expect(gatewayUrlProblem(undefined, `${CANON}/authorize`)).toMatch(/unset/);
  });

  it("names a value that is not an https URL", () => {
    expect(gatewayUrlProblem("charter.example.com", `${CANON}/authorize`)).toMatch(
      /https/,
    );
    expect(gatewayUrlProblem("http://charter.example.com", `${CANON}/authorize`))
      .toMatch(/https/);
  });

  // R3: this is the arm with no other detector. A placeholder parses fine and
  // gates nothing; the only evidence it is wrong is that no request arrives on
  // it. Before this, an unedited "https://charter-gateway.example.workers.dev"
  // ran normally while accepting redirect URIs on a host under a namespace a
  // third party can register.
  it("reports a configured origin no request ever arrives on", () => {
    const problem = gatewayUrlProblem(
      "https://charter-gateway.example.workers.dev",
      `${CANON}/authorize`,
    );
    expect(problem).toContain("https://charter-gateway.example.workers.dev");
    expect(problem).toContain(CANON);
  });

  it("accepts a hostname the operator declared in CHARTER_EXTRA_REDIRECT_ORIGINS", () => {
    expect(
      gatewayUrlProblem(CANON, "https://alt.example.com/authorize", [
        "https://alt.example.com",
      ]),
    ).toBeNull();
  });

  // wrangler dev serves on http://localhost:8787 against a production-shaped
  // config. Exempting loopback concedes nothing: a request carrying
  // Host: localhost merely gets the behaviour that existed before this check.
  it("exempts loopback so local development still runs", () => {
    for (const dev of [
      "http://localhost:8787/authorize",
      "http://127.0.0.1:8787/callback",
    ]) {
      expect(gatewayUrlProblem(CANON, dev)).toBeNull();
    }
  });
});
