"""The two §4.8 contract checks a connect verb must not re-implement."""
import pytest

from charter import upstream_connect as uc
from charter.errors import VerbError

GW = "https://gw.example.com/connect/hs/callback"
ALT = "https://alt.example.com/connect/hs/callback"


class TestAllowedRedirectUri:
    def test_exact_match_passes(self):
        assert uc.allowed_redirect_uri(GW, (GW, ALT)) == GW

    def test_absent_defaults_to_the_only_entry(self):
        assert uc.allowed_redirect_uri(None, (GW,)) == GW
        assert uc.allowed_redirect_uri("", (GW,)) == GW

    def test_absent_is_ambiguous_when_several_are_configured(self):
        # Silently picking the first would make the exchange depend on the
        # ordering of an env var.
        with pytest.raises(VerbError) as e:
            uc.allowed_redirect_uri(None, (GW, ALT))
        assert (e.value.status, e.value.code) == (400, "redirect_uri_not_allowed")

    def test_unlisted_is_refused(self):
        with pytest.raises(VerbError) as e:
            uc.allowed_redirect_uri("https://evil.example/cb", (GW,))
        assert (e.value.status, e.value.code) == (400, "redirect_uri_not_allowed")

    def test_no_normalization(self):
        # The upstream compares the authorize-time string byte for byte.
        for near in (GW + "/", GW.upper(), " " + GW):
            with pytest.raises(VerbError):
                uc.allowed_redirect_uri(near, (GW,))

    def test_non_string_is_refused_not_coerced(self):
        for bad in (123, ["x"], {"a": 1}, True):
            with pytest.raises(VerbError):
                uc.allowed_redirect_uri(bad, (GW,))

    def test_empty_allow_list_disables_the_flow(self):
        with pytest.raises(VerbError) as e:
            uc.allowed_redirect_uri(GW, ())
        assert (e.value.status, e.value.code) == (503, "connect_unconfigured")

    def test_caller_supplies_its_own_code_and_config_name(self):
        with pytest.raises(VerbError) as e:
            uc.allowed_redirect_uri("https://x/y", (GW,), code="hs_redirect_denied",
                                    config_key="HUBSPOT_REDIRECT_URIS")
        assert e.value.code == "hs_redirect_denied"
        assert "HUBSPOT_REDIRECT_URIS" in e.value.detail


class TestBindActor:
    def test_same_person_binds(self):
        assert uc.bind_actor("sam@example.com", "Sam@Example.com") == "sam@example.com"

    def test_different_person_is_refused(self):
        # The attack: a code for someone else's upstream account, pasted by a
        # user who cannot tell it apart from their own.
        with pytest.raises(VerbError) as e:
            uc.bind_actor("sam@example.com", "attacker@example.com")
        assert (e.value.status, e.value.code) == (403, "upstream_identity_mismatch")

    def test_missing_principal_fails_closed(self):
        for missing in (None, "", "   "):
            with pytest.raises(VerbError) as e:
                uc.bind_actor("sam@example.com", missing)
            assert e.value.code == "upstream_identity_mismatch"

    def test_no_actor_is_an_auth_error_not_a_mismatch(self):
        with pytest.raises(VerbError) as e:
            uc.bind_actor(None, "sam@example.com")
        assert (e.value.status, e.value.code) == (401, "actor_required")

    def test_caller_supplies_its_own_code_and_label(self):
        with pytest.raises(VerbError) as e:
            uc.bind_actor("sam@example.com", "other@example.com",
                          code="hs_identity_mismatch", label="HubSpot")
        assert e.value.code == "hs_identity_mismatch"
        assert "HubSpot" in e.value.detail
