"""packtest — the Charter pack conformance suite (U4).

A pytest-kit + single agent-runnable CLI that validates a pack against the
agent-facing contract through the real dispatcher, emitting structured failures
an authoring agent can self-correct from. See packtest.checks for the contract
and packtest.cli for the entry point.
"""
from . import checks

__all__ = ["checks"]
