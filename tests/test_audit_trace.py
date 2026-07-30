"""W3C trace context on audit rows (MCP spec 2026-07-28, SEP-414).

The caller's `traceparent` rides in an MCP request's `_meta`, the gateway
forwards it as a header, and the row records it -- which is what lets an
operator get from a slow tool call in their client to the audit row it wrote.

It is caller-controlled, so most of what is worth testing here is what does NOT
reach the row.
"""
import charter.audit as audit
import charter.main as main


GOOD = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


class FakeBQ:
    """Captures rows instead of writing them. insert_rows_json returns errors."""

    def __init__(self):
        self.rows = []

    def insert_rows_json(self, table, rows):
        self.rows.extend(rows)
        return []


def _fake_bq(monkeypatch):
    """Install a fake client without tripping audit's lazy __getattr__.

    setitem on the module dict, not setattr: audit reads `bq` and `TABLE`
    through globals(), and a plain getattr on either name constructs a real
    BigQuery client -- which is exactly what a test must not do.
    """
    fake = FakeBQ()
    monkeypatch.setitem(audit.__dict__, "bq", fake)
    monkeypatch.setitem(audit.__dict__, "TABLE", "proj.charter.audit")
    return fake


def _record():
    audit.record({"name": "jason", "interface": "cc"}, "sync.status", None, "ok",
                 rid="rid-1")


def test_well_formed_traceparent_lands_on_the_row(monkeypatch):
    bq = _fake_bq(monkeypatch)
    audit.begin_trace(GOOD)
    _record()
    assert bq.rows[0]["traceparent"] == GOOD


def test_absent_traceparent_omits_the_field(monkeypatch):
    # Omitted, not null: insert_rows_json rejects unknown fields, so a deploy
    # that lands before the ALTER TABLE must not send the column at all.
    bq = _fake_bq(monkeypatch)
    audit.begin_trace(None)
    _record()
    assert "traceparent" not in bq.rows[0]


def test_malformed_traceparent_is_dropped_not_stored(monkeypatch):
    bq = _fake_bq(monkeypatch)
    bad = [
        "garbage",
        "",
        # All-zero trace id / span id are invalid per the W3C spec.
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        # Wrong length, non-hex, unsupported version, surrounding whitespace.
        "00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01",
        "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        f" {GOOD}",
        f"{GOOD} ",
        # An audit row is evidence, not a place to park text.
        "x" * 5000,
        123,
    ]
    for value in bad:
        bq.rows.clear()
        audit.begin_trace(value)
        _record()
        assert "traceparent" not in bq.rows[0], value


def test_begin_trace_clears_a_previous_request(monkeypatch):
    # The reason begin_trace is called unconditionally: thread pools reuse
    # threads, so without this the previous request's trace would be attributed
    # to a request that carried none.
    bq = _fake_bq(monkeypatch)
    audit.begin_trace(GOOD)
    audit.begin_trace(None)
    _record()
    assert "traceparent" not in bq.rows[0]


def test_bridge_seeds_the_context_from_the_request_header(monkeypatch):
    """The wiring: the dispatcher reads the header before any row is written."""
    seen = []
    monkeypatch.setattr(main, "begin_trace", lambda tp: seen.append(tp))
    monkeypatch.setattr(main, "identify", lambda req: None)  # short-circuit to 401

    class Req:
        headers = {"traceparent": GOOD}

        def get_json(self, silent=False):
            return {"verb": "sync.status"}

    main.bridge(Req())
    assert seen == [GOOD]
