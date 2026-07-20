"""Public SDK for Charter packs.

Five primitives:

  register(verb, handler, audit_policy="post", *, read=None, dry_run=False)
      Add one exact verb. audit_policy: "post" = fail-open audit after the
      handler; "pre" = fail-closed attempt row before the side effect.
      `read` declares read/write intent; a declaration contradicting the leaf
      convention is refused (PackError "read_flag_conflict"). `dry_run`
      declares preview support (the dispatcher honors it per KTD-8).
  register_prefix(prefix, handler, catalog)
      Add a whole verb family dispatched by prefix (e.g. "data.query.").
      catalog = {"summary"?, "detail"?, "read" (required bool), "scope"
      (required: the verb a caller must be allowed for verbs.list to reveal
      the family)}. summary defaults to the handler's first docstring line.
  VerbError
      Structured verb failure: the dispatcher maps it to HTTP status + an
      audited error envelope. Raw exceptions map to 500 "internal".
  identity_context
      Request-scoped actor identity accessors: current() -> {"actor",
      "allow_shared", "credential_used"}; credential_used() ->
      "user:<email>" / "app" / None.
  get_config()
      The validated Settings object. Pack config values enter through here —
      never ad-hoc os.environ reads.

Handler-result conventions (SDK contract, enforced by the U4 conformance
suite):
  - result["_audit_detail"] is popped server-side into the audit row and
    never leaves the server;
  - result {"ok": False, ...} is a business rejection: HTTP 400 + a
    "rejected" audit row (the confirm gate uses this);
  - result["target"] is echoed into the audit row.

Read/write classification: the leaf convention (_READ_LEAVES, plus each
registered prefix family's declared flag) is the DEFAULT, not the boundary.
Registration refuses a declared read flag that contradicts the convention;
at runtime the read_only guard prefers the declared flag (exact verb first,
then the prefix family) over the leaf.

_safe(v) is the shared JSON-safety row sanitizer (date/datetime/Decimal).
Public packs import it from HERE, never from a private module.
"""
import datetime
import inspect
from decimal import Decimal

from charter.errors import VerbError
import charter.identity_context as identity_context
from charter.settings import get_settings

def _safe_deep(v):
    """_safe, recursively: handles nested ARRAY/STRUCT values."""
    if isinstance(v, list):
        return [_safe_deep(x) for x in v]
    if isinstance(v, dict):
        return {k: _safe_deep(x) for k, x in v.items()}
    return _safe(v)


__all__ = ["VERBS", "PREFIXES", "PackError", "VerbError", "identity_context",
           "get_config", "register", "register_prefix", "is_read", "_safe", "_safe_deep",
           "summary"]


class PackError(Exception):
    """Pack registration / loading failure, named for logs and conformance."""


VERBS = {}           # verb -> (handler, audit_policy); THE registry — main.VERBS aliases this object
PREFIXES = {}        # prefix -> PrefixEntry, insertion-ordered (dispatch order)
_DECLARED_READ = {}  # verb -> declared read flag (exact registrations)
_DRY_RUN = set()     # verbs declaring dry_run support (read by the dispatcher, KTD-8)
_TARGET_PREFIXES = {}  # verb -> audit-target prefix (e.g. "hubspot_email"); packs declare at register

# Action leaves that read without a side effect; everything else is a write.
# "whoami" reads the caller's own auth surface (identity.whoami).
_READ_LEAVES = {"status", "read", "list", "fetch", "views", "query", "schema",
                "whoami"}


class PrefixEntry:
    __slots__ = ("handler", "summary", "detail", "read", "scope", "audit_policy")

    def __init__(self, handler, summary, detail, read, scope, audit_policy="post"):
        self.handler = handler
        self.summary = summary
        self.detail = detail
        self.read = read
        self.scope = scope
        self.audit_policy = audit_policy


def summary(fn):
    """First docstring line of a verb handler (PEP 257 summary); '' if undocumented."""
    return (inspect.getdoc(fn) or "").split("\n", 1)[0]


def target_prefix(verb):
    """Audit-target prefix declared for this verb, or None."""
    return _TARGET_PREFIXES.get(verb)


def is_read(verb):
    """Read/write classification: declared exact-verb flag first, then the
    registered prefix family's declared flag, then the leaf convention. The
    single source of truth for the verbs.list catalog flag and the read-only
    tool guard."""
    if verb in _DECLARED_READ:
        return _DECLARED_READ[verb]
    for prefix, entry in PREFIXES.items():
        if verb.startswith(prefix):
            return entry.read
    return verb.rsplit(".", 1)[-1] in _READ_LEAVES


def register(verb, handler, audit_policy="post", *, read=None, dry_run=False,
             target_prefix=None):
    """Register one exact verb. Refuses (PackError) a name collision or a
    declared read flag contradicting the leaf/prefix convention."""
    if verb in VERBS:
        raise PackError(f"verb_collision: {verb!r} is already registered")
    if read is not None and bool(read) != is_read(verb):
        raise PackError(
            f"read_flag_conflict: {verb!r} declares read={bool(read)} but the "
            "leaf convention classifies it the opposite way")
    VERBS[verb] = (handler, audit_policy)
    if target_prefix is not None:
        _TARGET_PREFIXES[verb] = target_prefix
    if read is not None:
        _DECLARED_READ[verb] = bool(read)
    if dry_run:
        _DRY_RUN.add(verb)


def register_prefix(prefix, handler, catalog):
    """Register a prefix-dispatched verb family. catalog requires "read"
    (bool) and "scope" (the verb a caller must be allowed for verbs.list to
    reveal the family); "summary" defaults to the handler's docstring."""
    if prefix in PREFIXES:
        raise PackError(f"prefix_collision: {prefix!r} is already registered")
    if "read" not in catalog or "scope" not in catalog:
        raise PackError(
            f"bad_catalog: {prefix!r} catalog requires 'read' and 'scope' keys")
    PREFIXES[prefix] = PrefixEntry(
        handler,
        summary=catalog.get("summary") or summary(handler),
        detail=catalog.get("detail", ""),
        read=bool(catalog["read"]),
        scope=catalog["scope"])


def get_config():
    """The validated Settings object (pydantic-settings, fail-fast at boot)."""
    return get_settings()


def _safe(v):
    """JSON-safe coercion for BigQuery row values.

    Handles date, datetime, and Decimal only.
    STRUCT and ARRAY columns are NOT supported — flatten them in the view definition.
    Any other type is returned as-is and must be natively JSON-serialisable.
    """
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v
