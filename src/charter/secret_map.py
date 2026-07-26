"""A JSON map read live from Secret Manager and cached for TTL_SECONDS.

Charter identifies callers two ways, and both hang off one object: a JSON map
in a Secret Manager secret — `charter-keys` (auth.py) for headless API keys,
`charter-grants` (grants.py) for verified humans. Both are re-read every
TTL_SECONDS, so add/rotate/revoke takes effect with no redeploy; both take an
env var as a cold-start fallback when Secret Manager is briefly unreachable at
boot; both are hand-edited by an operator, so both must fail closed.

Fail-closed means never raising: a fetch error keeps the last-good map, and a
payload of the wrong shape (not a JSON object — e.g. a top-level array) or
malformed fallback JSON is logged and yields an empty map. Identification runs
BEFORE the dispatcher's try block, so an exception from here is a bare 500 with
no audit row and no request_id.
"""
import json
import time
import logging

from google.cloud import secretmanager

from charter.settings import get_settings

TTL_SECONDS = 60


def _sm_client():
    """Lazy Secret Manager client. Reads through module globals so a patched
    `secret_map.sm` keeps working; importing this module needs no credentials."""
    c = globals().get("sm")
    if c is None:
        c = globals()["sm"] = secretmanager.SecretManagerServiceClient()
    return c


def __getattr__(name):
    if name == "sm":
        return _sm_client()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


class SecretMap:
    """One named secret's map. `secret_field` and `env_field` are Settings
    attribute names, read per call so a config change is picked up.

    `fetch_log_level` is ERROR for a map the deployment requires (keys) and
    WARNING for an optional one (grants): a deployment with no charter-grants
    secret at all logs a failed fetch every TTL forever, and that is a normal
    quiet state, not an incident.
    """

    def __init__(self, label, secret_field, env_field, fetch_log_level=logging.ERROR):
        self.label = label
        self.secret_field = secret_field
        self.env_field = env_field
        self.fetch_log_level = fetch_log_level
        self._map = None
        self._loaded_at = 0.0

    def _secret_path(self):
        s = get_settings()
        return (f"projects/{s.gcp_project}/secrets/"
                f"{getattr(s, self.secret_field)}/versions/latest")

    def _fetch(self):
        """Read the latest map from Secret Manager (the live source of truth)."""
        resp = _sm_client().access_secret_version(name=self._secret_path())
        return json.loads(resp.payload.data.decode("utf-8"))

    def get(self):
        """The cached map, refreshed every TTL_SECONDS.

        `_loaded_at` is bumped on every attempt, so a persistent outage doesn't
        hammer Secret Manager on every request.
        """
        if self._map is None or (time.time() - self._loaded_at) > TTL_SECONDS:
            try:
                fetched = self._fetch()
                if not isinstance(fetched, dict):
                    raise ValueError(
                        f"payload is a {type(fetched).__name__}, not an object")
                self._map = fetched
            except Exception as e:
                logging.log(self.fetch_log_level, "%s fetch failed: %s", self.label, e)
                if self._map is None:                 # cold start: fall back to env
                    self._map = self._from_env()
            self._loaded_at = time.time()
        return self._map

    def _from_env(self):
        """The env var fallback, or an empty map if it too is unusable."""
        try:
            raw = getattr(get_settings(), self.env_field).get_secret_value()
            parsed = json.loads(raw or "{}")
        except Exception as e:
            logging.error("%s: %s fallback invalid: %s",
                          self.label, self.env_field.upper(), e)
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def reload(self):
        """Force the next get() to re-fetch (a failed re-fetch keeps last-good)."""
        self._loaded_at = 0.0

    def reset(self):
        """Forget the cached map entirely: the next get() is a cold start."""
        self._map = None
        self._loaded_at = 0.0
