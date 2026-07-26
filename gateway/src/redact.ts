/**
 * Strip anything credential-shaped out of text bound for a model, a log, or a
 * browser-visible error.
 *
 * One implementation shared by core.ts (the CF Access pair and the optional
 * API key) and google.ts (the Google client secret) — both used to do this
 * same string-splice with a different signature.
 *
 * Callers that also truncate for length MUST redact first and truncate
 * second. Cutting a live secret before this function sees it can slice it in
 * half, leaving a fragment with no whole-string match left to remove — that
 * previously let 18 characters of a live Google client secret reach a
 * browser-visible error. See google.ts's `tokenRequest` and
 * gateway/test/google.test.ts's "redacts a secret even when truncation would
 * otherwise cut it in half" regression test.
 *
 * core.ts had the same defect on its streaming byte cap, on the success path:
 * its readCapped now over-reads by the longest secret and redacts before
 * cutting, and gateway/test/core.test.ts sweeps the cut across a secret one
 * byte at a time to keep it that way.
 */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    // Ignore anything too short to be a real credential — redacting a 1-3
    // character "secret" would eat ordinary text around it.
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}
