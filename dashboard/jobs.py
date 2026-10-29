"""Bounded, read-only job observation. No process control or artifact building."""

from __future__ import annotations

import copy
import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

WORKSPACE = Path(__file__).resolve().parents[1]
CATALOG = tuple(json.loads((WORKSPACE / "tools/audit-job-catalog.json").read_text(encoding="utf-8")))
MAX_OUTPUT_BYTES = 131_072
COLLECTOR_TIMEOUT = 8
CACHE_SECONDS = 15
STALE_SECONDS = 45
STATUSES = {"OK", "UNAVAILABLE", "UNSUPPORTED", "ERROR"}


def _iso(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.year < 2000:
            return None
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError):
        return None


def _integer(value: Any, low: int, high: int) -> int | None:
    return value if type(value) is int and low <= value <= high else None


def _boolean(value: Any) -> bool | None:
    return value if type(value) is bool else None


def _unknown_process() -> dict[str, Any]:
    return dict(state="UNKNOWN", pid=None, pids=[], instanceCount=0, startedAt=None,
                windowVisible=None, matchKind="NONE")


def _unknown_schedule(task_id: str) -> dict[str, Any]:
    return dict(taskId=task_id, state="UNKNOWN", enabled=None, cadenceSeconds=None,
                nextRunAt=None, lastRunAt=None, lastResultCode=None, hiddenLaunch=None)


def collect_windows() -> dict[str, Any]:
    """Only the fixed local collector can run; stdout is bounded before buffering."""
    if os.name != "nt":
        return {"inspection": {"processes": "UNSUPPORTED", "scheduler": "UNSUPPORTED"}}
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    argv = [str(executable), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(WORKSPACE / "tools/read-audit-jobs.ps1")]
    process = subprocess.Popen(
        argv, cwd=str(WORKSPACE), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    output: list[bytes] = []
    done = threading.Event()

    def read_bounded() -> None:
        try:
            output.append(process.stdout.read(MAX_OUTPUT_BYTES + 1))
        except OSError:
            pass
        finally:
            done.set()

    worker = threading.Thread(target=read_bounded, daemon=True)
    worker.start()
    started = time.monotonic()
    try:
        if not done.wait(COLLECTOR_TIMEOUT) or not output or len(output[0]) > MAX_OUTPUT_BYTES:
            raise ValueError("collector unavailable")
        process.wait(timeout=max(0.01, COLLECTOR_TIMEOUT - (time.monotonic() - started)))
        if process.returncode != 0:
            raise ValueError("collector unavailable")
        result = json.loads(output[0].decode("utf-8-sig"))
        if not isinstance(result, dict):
            raise ValueError("invalid observation")
        return result
    finally:
        if process.poll() is None:
            process.kill()  # Only our short-lived read-only collector, never a managed job.
            process.wait(timeout=2)
        worker.join(timeout=1)
        process.stdout.close()


def sanitize(raw: Any, now: float) -> dict[str, Any]:
    """Project only contract fields and catalog identities; raw strings never escape."""
    raw = raw if isinstance(raw, dict) else {}
    inspection = raw.get("inspection", {})
    inspection = inspection if isinstance(inspection, dict) else {}
    statuses = {key: inspection.get(key) if isinstance(inspection.get(key), str) and inspection.get(key) in STATUSES else "ERROR"
                for key in ("processes", "scheduler")}
    observed = _iso(raw.get("observedAt"))
    age = now - datetime.fromisoformat(observed.replace("Z", "+00:00")).timestamp() if observed else None
    fresh = age is not None and -5 <= age <= STALE_SECONDS
    freshness = "FRESH" if fresh and "OK" in statuses.values() else "STALE" if observed else "UNAVAILABLE"
    rows = raw.get("jobs")
    rows = rows if isinstance(rows, list) and len(rows) <= 100 else []
    allowed = {item["id"] for item in CATALOG}
    by_id: dict[str, dict[str, Any]] = {}
    duplicates = set()
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"] in allowed:
            if row["id"] in by_id:
                duplicates.add(row["id"])
            by_id[row["id"]] = row
    jobs = []
    for spec in CATALOG:
        row = by_id.get(spec["id"], {}) if spec["id"] not in duplicates else {}
        proc = _unknown_process()
        source = row.get("process")
        if fresh and statuses["processes"] == "OK" and spec.get("script") and isinstance(source, dict):
            pids = source.get("pids")
            match = source.get("matchKind")
            if (source.get("state") == "RUNNING" and isinstance(pids, list) and 0 < len(pids) <= 128
                    and all(_integer(pid, 1, 4_294_967_295) is not None for pid in pids)
                    and isinstance(match, str) and match in {"WORKSPACE_PATH", "SCRIPT_MATCH"}):
                pids = sorted(set(pids))
                proc.update(state="RUNNING", pids=pids, instanceCount=len(pids),
                            pid=pids[0] if len(pids) == 1 else None, matchKind=match,
                            startedAt=_iso(source.get("startedAt")) if len(pids) == 1 else None,
                            windowVisible=_boolean(source.get("windowVisible")))
            elif source.get("state") == "NOT_RUNNING" and pids == []:
                proc["state"] = "NOT_RUNNING"
        schedule = None
        if spec.get("taskId"):
            schedule = _unknown_schedule(spec["taskId"])
            source = row.get("schedule")
            if (fresh and statuses["scheduler"] == "OK" and isinstance(source, dict)
                    and source.get("taskId") == spec["taskId"]):
                state = source.get("state")
                if isinstance(state, str) and state in {"RUNNING", "READY", "DISABLED", "QUEUED", "MISSING", "UNKNOWN"}:
                    schedule["state"] = state
                if schedule["state"] not in {"MISSING", "UNKNOWN"}:
                    schedule.update(enabled=_boolean(source.get("enabled")),
                                    cadenceSeconds=_integer(source.get("cadenceSeconds"), 1, 31_536_000),
                                    nextRunAt=_iso(source.get("nextRunAt")), lastRunAt=_iso(source.get("lastRunAt")),
                                    lastResultCode=_integer(source.get("lastResultCode"), -2_147_483_648, 4_294_967_295),
                                    hiddenLaunch=_boolean(source.get("hiddenLaunch")))
        jobs.append({"id": spec["id"], "label": spec["label"], "description": spec["description"],
                     "kind": spec["kind"], "scriptId": spec["id"], "process": proc, "schedule": schedule})
    return {"schema": "audit-jobs/v1", "observedAt": observed, "freshness": freshness,
            "inspection": statuses, "jobs": jobs}


class JobsInspector:
    """App-local cache serializes refreshes; a failure immediately demotes liveness."""

    def __init__(self, collector: Callable[[], dict[str, Any]] | None = None):
        self.collector = collector or collect_windows
        self._lock = threading.Lock()
        self._raw: dict[str, Any] = {}
        self._checked: float | None = None

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            tick = time.monotonic()
            if self._checked is None or tick - self._checked >= CACHE_SECONDS:
                try:
                    raw = self.collector()
                    if not isinstance(raw, dict):
                        raise ValueError("invalid observation")
                    if _iso(raw.get("observedAt")) is None:
                        if raw.get("inspection") != {"processes": "UNSUPPORTED", "scheduler": "UNSUPPORTED"}:
                            raise ValueError("invalid observation timestamp")
                        raw = dict(raw, observedAt=self._raw.get("observedAt"))
                    self._raw = raw
                except Exception:
                    self._raw = {"observedAt": self._raw.get("observedAt"),
                                 "inspection": {"processes": "ERROR", "scheduler": "ERROR"}}
                self._checked = time.monotonic()
            return sanitize(copy.deepcopy(self._raw), time.time())
