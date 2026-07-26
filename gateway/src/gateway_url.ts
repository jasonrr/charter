/**
 * `CHARTER_GATEWAY_URL` — the gateway's own canonical origin — and why a wrong
 * one has to be loud.
 *
 * That variable decides which https redirect URIs a dynamically registered
 * client may claim as "this gateway" (redirect_uri.ts), and it is now also what
 * the gateway publishes about itself as an OAuth protected resource (prm.ts).
 * Pinning it to configuration instead of the request's Host closed the
 * Host-header hole. It opened a quieter one: a *wrong* value had no symptom.
 * It was absent from `missingConfig`, never compared against the origin the
 * request actually arrived on, and shipped as a placeholder under `workers.dev`
 * — a real, registrable namespace, unlike the IANA-reserved `example.com` used
 * for the rest of the sample config.
 *
 * A deploy that never edited it therefore worked in every visible respect while
 * accepting redirect URIs on a host the operator does not own. Whoever holds
 * that subdomain can register a client there, and the consent page shows it as
 * the destination — the confused-deputy path redirect_uri.ts exists to prevent.
 *
 * So: unset or unparseable is a named failure, and an origin that does not
 * match the request is a named failure. Both fail on the sign-in routes, where
 * a human is present to read the reason.
 */
import { isLoopbackHost } from "./redirect_uri.js";

/**
 * The configured canonical origin, or "" if it is unusable.
 *
 * https is required, not merely conventional: `screenRedirectUris` only ever
 * compares this against https URIs, so an `http://` value silently matches
 * nothing and rejects every legitimate registration.
 */
export function gatewayOrigin(configured: string | undefined): string {
  if (!configured) return "";
  let u: URL;
  try {
    u = new URL(configured);
  } catch {
    return "";
  }
  return u.protocol === "https:" ? u.origin : "";
}

/**
 * What is wrong with `CHARTER_GATEWAY_URL` for this request, or null.
 *
 * The mismatch arm is the part with no other detector. An unedited placeholder
 * parses fine and gates nothing; the only evidence that it is wrong is that no
 * request ever arrives on it.
 *
 * Loopback request origins are exempt so `wrangler dev` still runs against a
 * production-shaped config. That concedes nothing: a request carrying
 * `Host: localhost` merely skips this check and gets the behaviour that existed
 * before it, and registration screening still pins to the configured origin.
 */
export function gatewayUrlProblem(
  configured: string | undefined,
  requestUrl: string,
  extraOrigins: string[] = [],
): string | null {
  if (!configured) {
    return "CHARTER_GATEWAY_URL is unset.";
  }
  const origin = gatewayOrigin(configured);
  if (!origin) {
    return `CHARTER_GATEWAY_URL is not an https:// URL (got "${configured}").`;
  }

  let requested: URL;
  try {
    requested = new URL(requestUrl);
  } catch {
    return null; // not something the operator can act on
  }
  if (isLoopbackHost(requested.hostname)) return null;
  if (requested.origin === origin) return null;
  if (extraOrigins.includes(requested.origin)) return null;

  return (
    `CHARTER_GATEWAY_URL is ${origin}, but this request arrived at ` +
    `${requested.origin}. One of the two is wrong: registration screening and ` +
    "the gateway's protected-resource metadata both trust the configured " +
    "origin, so a stale or placeholder value would let a client register " +
    "redirect URIs on a host you do not control. Set CHARTER_GATEWAY_URL to " +
    "this gateway's real origin, or add the other hostname to " +
    "CHARTER_EXTRA_REDIRECT_ORIGINS if the deploy legitimately answers both."
  );
}
