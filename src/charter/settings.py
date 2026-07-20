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
    model_config = SettingsConfigDict(env_file=".env", extra="allow")

    # Required engine config — no defaults; startup fails fast when unset.
    gcp_project: str
    google_oauth_client_id: str
    allowed_domain: str

    # Resource names (defaults preserve the pre-settings values).
    keys_secret_name: str = "charter-keys"
    google_refresh_secret_name: str = "charter-google-refresh"
    audit_table: str = "charter.audit"  # dataset.table, joined with gcp_project
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
    personal_access_token: SecretStr = SecretStr("")  # airtable pack
    posthog_api_key: SecretStr = SecretStr("")        # posthog pack (reference)
    dropboxsign_token: SecretStr = SecretStr("")      # dropboxsign pack (reference)
    dropboxsign_template_id: str = ""
    test_mode: str = ""
    test_mode_email: str = ""

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
