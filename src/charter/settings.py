"""Typed deploy-time configuration for Charter (pydantic-settings v2).

One Settings object carries every environment-specific ENGINE value; modules
read it through get_settings() (cached) instead of module-top literals.
main.py calls get_settings() at import, so a missing required value fails at
startup with a pydantic ValidationError naming the field — never a mid-request
500. Field names map to UPPER_SNAKE env vars; those names are the public
config API (a rename breaks consuming deployments at boot).

Pack-scoped values are NOT here — they live behind the owning pack's config
seam: packs declare required_config keys (validated non-empty at boot by
sdk.loader) and read values back through sdk.get_config().
"""
from functools import lru_cache
from typing import Annotated

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    # hide_input_in_errors: a boot-time ValidationError (missing required field)
    # must not echo the OTHER env values — some are secrets — into logs.
    model_config = SettingsConfigDict(env_file=".env", extra="allow",
                                      hide_input_in_errors=True)

    # Required engine config — no defaults; startup fails fast when unset.
    gcp_project: str
    google_oauth_client_id: str
    allowed_domain: str

    # Resource names (defaults preserve the pre-settings values).
    keys_secret_name: str = "charter-keys"
    grants_secret_name: str = "charter-grants"
    google_refresh_secret_name: str = "charter-google-refresh"
    audit_table: str = "charter.audit"  # dataset.table, joined with gcp_project
    # §4.5 payload offload: GCS bucket for oversized success envelopes. Empty
    # disables offload (results stay inline; the gateway truncates at 1 MB).
    results_bucket: str = ""
    # Success-envelope size above which bridge() offloads (bytes of UTF-8 JSON).
    max_inline_bytes: int = 262144
    # NoDecode: accept CSV from env ("a,b") instead of pydantic's JSON decoding.
    warehouse_datasets: Annotated[tuple[str, ...], NoDecode] = ()
    # Shipped reference packs' config — declared so env binds (pydantic-settings
    # only reads declared fields from process env). Third-party packs read
    # os.environ directly (see the posthog reference in the docs).
    warehouse_sa_email: str = ""  # default: warehouse-query@<gcp_project>
    airtable_base_id: str = ""
    airtable_table_ids: str = ""   # JSON map: table name -> table id
    airtable_field_ids: str = ""   # JSON map: field name -> field id

    # Pack discovery: config-listed module paths and/or entry-point
    # distribution names (allow-list). Empty = engine verbs only.
    packs: Annotated[tuple[str, ...], NoDecode] = ("charter",)

    # Pre-existing env passthroughs (the seven os.environ reads), SecretStr so
    # repr/str never leak material. All optional; consumers fail as before.
    charter_keys: SecretStr = SecretStr("")       # auth.py cold-start fallback JSON
    charter_grants: SecretStr = SecretStr("")     # grants.py cold-start fallback JSON
    personal_access_token: SecretStr = SecretStr("")  # airtable pack
    posthog_api_key: SecretStr = SecretStr("")        # posthog pack (reference)
    dropboxsign_token: SecretStr = SecretStr("")      # dropboxsign pack (reference)
    dropboxsign_template_id: str = ""

    @field_validator("allowed_domain")
    @classmethod
    def _anchor_domain(cls, v: str) -> str:
        # actor_auth matches with email.endswith(allowed_domain); without a
        # leading "@" that suffix check accepts anyone@evil-example.com for
        # ALLOWED_DOMAIN=example.com. Normalize here so every construction
        # path gets the anchored form.
        v = v.strip()
        return v if v.startswith("@") else f"@{v}"

    @field_validator("warehouse_datasets", "packs", mode="before")
    @classmethod
    def _parse_csv(cls, v):
        if isinstance(v, str):
            return tuple(p.strip() for p in v.split(",") if p.strip())
        return v


@lru_cache
def get_settings() -> Settings:
    """Process-wide Settings, cached. Tests cache_clear() between env changes."""
    return Settings()
