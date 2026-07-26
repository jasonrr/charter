import { describe, expect, it } from "vitest";
import { isAuthRoute } from "../src/routes.js";

describe("isAuthRoute", () => {
  it("gates every sign-in route, including the consent POST (S1 regression)", () => {
    expect(isAuthRoute("/authorize")).toBe(true);
    expect(isAuthRoute("/authorize/continue")).toBe(true);
    expect(isAuthRoute("/callback")).toBe(true);
  });

  it("does not gate unrelated paths", () => {
    expect(isAuthRoute("/mcp")).toBe(false);
    expect(isAuthRoute("/register")).toBe(false);
    expect(isAuthRoute("/")).toBe(false);
    expect(isAuthRoute("/authorize/")).toBe(false);
  });
});
