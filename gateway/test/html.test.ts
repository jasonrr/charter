import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/html.js";

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
