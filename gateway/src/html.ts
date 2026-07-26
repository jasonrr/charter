/**
 * HTML escaping for the consent page.
 *
 * The consent screen renders a redirect URI's origin, which comes from a
 * client anyone can register — so it is attacker-supplied by definition, and
 * the one value on that page that must not be able to close a tag. This is the
 * only place the gateway emits HTML at all; every other error response is
 * text/plain precisely so it cannot become a script sink.
 *
 * Escapes quotes as well as angle brackets so the same function is safe in an
 * attribute value, not just in text.
 */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
