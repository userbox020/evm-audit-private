"""Shared, read-only signed-batch verification for dashboard views."""

from __future__ import annotations

import json
import re
import subprocess
from typing import Any

from .artifacts import ArtifactReader
from .normalize import timestamp

EXECUTION_STATES = frozenset({"ABSENT", "INVALID", "NOT_YET_VALID", "VALID", "EXPIRED", "CONSUMED", "REVOKED"})
WINDOW_STATES = frozenset({"NOT_YET_VALID", "VALID", "EXPIRED", "CONSUMED", "REVOKED"})
TIME_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")
EXECUTION_REASON = "No route-specific verified arming controller is connected"


def execution_view(reader: ArtifactReader, now: float) -> dict[str, Any]:
    """Only the fixed first-party verifier may establish signed-batch state."""

    result = {
        "authorization_state": "UNAVAILABLE", "expires_at": None, "expires_in": None,
        "not_before": None, "verification": "UNAVAILABLE", "readiness": "NOT_READY",
        "readiness_reason": EXECUTION_REASON, "scope": "NOT_VERIFIED",
    }
    try:
        completed = subprocess.run(
            ["node", str(reader.root / "tools" / "live-execution-batch.js"), "status"],
            cwd=reader.root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=2, check=False,
        )
        output = getattr(completed, "stdout", None)
        if completed.returncode != 0 or not isinstance(output, bytes) or len(output) > 8192:
            return result
        report = json.loads(output)
        if not isinstance(report, dict) or report.get("ok") is not True:
            return result
        state = report.get("authorizationState")
        if not isinstance(state, str) or state not in EXECUTION_STATES:
            return result
        expires_at = not_before = expires_in = None
        if state in WINDOW_STATES:
            batch = report.get("batch")
            if not isinstance(batch, dict):
                return result
            chain_id = batch.get("chainId")
            # Signed-batch schemas serialize integers as decimal strings.
            if not (
                type(chain_id) is int and 0 < chain_id <= 4_294_967_295
                or isinstance(chain_id, str) and re.fullmatch(r"[1-9][0-9]{0,9}", chain_id)
                and int(chain_id) <= 4_294_967_295
            ):
                return result
            expires_at, not_before = batch.get("expiresAt"), batch.get("notBefore")
            if any(
                not isinstance(value, str) or not TIME_PATTERN.fullmatch(value) or timestamp(value) is None
                for value in (expires_at, not_before)
            ) or timestamp(not_before) > timestamp(expires_at):
                return result
            expires_in = max(0, int(timestamp(expires_at) - now)) if state in {"VALID", "NOT_YET_VALID"} else 0
        return {
            **result, "authorization_state": state, "expires_at": expires_at,
            "expires_in": expires_in, "not_before": not_before, "verification": "VERIFIED",
        }
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, RecursionError):
        return result
