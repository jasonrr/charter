import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

describe("redact", () => {
  it("replaces every occurrence of a secret with a fixed marker", () => {
    expect(redact("a cfsecret b cfsecret c", ["cfsecret"])).toBe(
      "a [redacted] b [redacted] c",
    );
  });

  it("redacts multiple distinct secrets in one pass", () => {
    expect(redact("id=cfid key=apikey", ["cfid", "apikey"])).toBe(
      "id=[redacted] key=[redacted]",
    );
  });

  it("ignores undefined and empty secrets rather than throwing", () => {
    expect(redact("hello world", [undefined, ""])).toBe("hello world");
  });

  it("ignores a secret shorter than 4 characters, so it can't eat ordinary text", () => {
    expect(redact("cat", ["cat"])).toBe("cat");
    expect(redact("ab", ["ab"])).toBe("ab");
  });

  it("leaves text with no matching secret untouched", () => {
    expect(redact("nothing to see here", ["cfsecret"])).toBe("nothing to see here");
  });
});
