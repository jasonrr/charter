"""Verified human identity (actor) from the X-Actor-Token header.

The MCP proxy sends a Google ID token (scopes: openid email) minted for the
charter-identity OAuth client. actor_email() verifies it cryptographically
and returns the allowed-domain email; None when the header is absent; and
raises VerbError(401, "actor_invalid") when present-but-bad — a bad token is
always an error, never silently anonymous. Verified results are cached by
token hash until the token expires so Google's certs aren't fetched per call.
"""
import time
import hashlib
import typing

from google.oauth2 import id_token as _google_id_token
from google.auth.transport import requests as _ga_requests

from charter.errors import VerbError
from charter.settings import get_settings

_CACHE_MAX = 128

_request = _ga_requests.Request()
_cache = {}  # sha256(token) -> (email, exp_epoch)


class ActorProvider(typing.Protocol):
    """The actor-verification seam: verify an ID token, return its claims
    (raising on invalid). One impl ships in v1; a second provider (R4's
    pluggable identity) implements this protocol."""

    def verify_claims(self, token: str) -> dict: ...


class GoogleOIDC:
    """Google OIDC provider: verifies ID tokens minted for the configured
    OAuth client (settings.google_oauth_client_id); the hosted-domain and
    email_verified checks live in actor_email, not here."""

    def verify_claims(self, token):
        return _google_id_token.verify_oauth2_token(
            token, _request, get_settings().google_oauth_client_id,
            clock_skew_in_seconds=10)


_provider: ActorProvider = GoogleOIDC()


def __getattr__(name):
    # CLIENT_ID / DOMAIN are settings values (engine config), resolved lazily so
    # importing this module never requires config to be present.
    if name == "CLIENT_ID":
        return get_settings().google_oauth_client_id
    if name == "DOMAIN":
        return get_settings().allowed_domain
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def actor_email(request):
    """Verified actor email from X-Actor-Token; None when absent; VerbError(401) when invalid."""
    token = request.headers.get("X-Actor-Token", "")
    if not token:
        return None
    key = hashlib.sha256(token.encode("utf-8")).hexdigest()
    hit = _cache.get(key)
    if hit and hit[1] > time.time():
        return hit[0]
    try:
        claims = _provider.verify_claims(token)
    except Exception as e:
        # Detail carries only the exception CLASS name: google-auth messages can embed
        # the raw token bytes (MalformedError: "Wrong number of segments in token:
        # b'<token>'"), and the token must never appear in a response or log line.
        raise VerbError(401, "actor_invalid",
                        f"identity token rejected ({type(e).__name__})") from None
    domain = get_settings().allowed_domain
    email = claims.get("email", "")
    if not claims.get("email_verified") or not email.endswith(domain):
        raise VerbError(401, "actor_invalid",
                        f"identity must be a verified {domain} account "
                        f"(got {email or 'no email'}); re-run your identity provider login "
                        "and pick your work account")
    if len(_cache) >= _CACHE_MAX:
        _cache.clear()  # ponytail: tiny cache, rare full wipe beats LRU bookkeeping
    _cache[key] = (email, claims["exp"])
    return email
