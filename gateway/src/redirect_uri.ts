/**
 * Which redirect URIs a dynamically registered client may have.
 *
 * This is the control that actually *prevents* the confused-deputy attack the
 * consent screen only warns about. Registration is open, so before this an
 * attacker could register a client pointing at a server they own, phish a
 * victim through a genuine Google consent, and have the authorization code
 * delivered to themselves.
 *
 * A loopback URI cannot be collected remotely — it resolves on the victim's own
 * machine — so there is nowhere for the code to go. That, plus the gateway's own
 * origin, is the whole allow-list. No vendor names, nothing to maintain.
 *
 * The MCP spec's authorization Security Considerations put the same requirement
 * on the other half of this (the consent screen):
 *
 *   "MCP proxy servers using static client IDs MUST obtain user consent for each
 *    dynamically registered client before forwarding to third-party
 *    authorization servers (which may require additional consent)."
 *
 * and, on the authorization server's side, that it "SHOULD only automatically
 * redirect the user agent if it trusts the redirection URI." Trusting it is
 * exactly what this module decides.
 */

/** Hosts that can only ever reach the machine the browser is running on. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type Verdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Split an operator-configured origin list.
 *
 * Deliberately an *origin* list rather than a URI list: an operator adding a
 * client should not have to predict its exact callback path, and matching on
 * origin is what keeps the comparison free of path-normalisation tricks.
 */
export function parseExtraOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export function classifyRedirectUri(
  uri: unknown,
  gatewayOrigin: string,
  extraOrigins: string[] = [],
): Verdict {
  if (typeof uri !== "string" || uri === "") {
    return { allowed: false, reason: "must be a non-empty string" };
  }

  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { allowed: false, reason: "must be an absolute URL" };
  }

  // "https://localhost@evil.example/" has hostname evil.example — the loopback
  // is only in the userinfo. Refuse userinfo outright rather than rely on every
  // later reader parsing it the same way we did.
  if (u.username !== "" || u.password !== "") {
    return { allowed: false, reason: "must not contain a username or password" };
  }

  // URL already lowercases and punycodes the host, which is what makes
  // "%6cocalhost" and unicode look-alikes resolve to their real hostname here
  // rather than sneaking through a raw string comparison.
  const host = u.hostname.toLowerCase();

  if (LOOPBACK_HOSTS.has(host)) {
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { allowed: false, reason: "loopback must use http or https" };
    }
    return { allowed: true };
  }

  if (u.protocol !== "https:") {
    return { allowed: false, reason: "must use https unless it is loopback" };
  }
  if (u.origin === gatewayOrigin || extraOrigins.includes(u.origin)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "must be a loopback address (localhost, 127.0.0.1, [::1]) or an https " +
      `URI on ${gatewayOrigin}`,
  };
}

export type Screening = {
  accepted: string[];
  rejected: { uri: string; reason: string }[];
};

/**
 * Screen a registration's whole `redirect_uris` array.
 *
 * Rejected entries are dropped rather than failing the registration, because
 * real clients send mixed arrays: VS Code registers loopback *and*
 * `https://vscode.dev/redirect` in one call, and failing the whole request
 * would lock it out entirely when its primary loopback flow is perfectly
 * acceptable. RFC 7591 has the registration response echo the redirect URIs
 * actually registered, so a client is told what it got. A registration with
 * nothing acceptable left is refused outright by the caller.
 */
export function screenRedirectUris(
  uris: unknown,
  gatewayOrigin: string,
  extraOrigins: string[] = [],
): Screening {
  const out: Screening = { accepted: [], rejected: [] };
  if (!Array.isArray(uris)) return out;
  for (const uri of uris) {
    const verdict = classifyRedirectUri(uri, gatewayOrigin, extraOrigins);
    if (verdict.allowed) out.accepted.push(uri as string);
    else out.rejected.push({ uri: String(uri), reason: verdict.reason });
  }
  return out;
}
