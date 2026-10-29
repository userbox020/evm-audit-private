"""Collector lifecycle checks: synthetic clocks, stubbed child, no real IO/RPC."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import dashboard.wallets as wallets
from conftest import get


@pytest.fixture
def controlled(monkeypatch):
    clock = SimpleNamespace(wall=0.0, mono=0.0)
    tasks = []

    class DeferredThread:
        def __init__(self, target, args, daemon):
            assert daemon is True
            tasks.append(lambda: target(*args))

        def start(self):
            pass

    epoch = datetime(2026, 10, 28, tzinfo=timezone.utc)
    monkeypatch.setattr(wallets, "_now", lambda: (epoch + timedelta(seconds=clock.wall)).isoformat())
    monkeypatch.setattr(wallets, "time", SimpleNamespace(time=lambda: clock.wall, monotonic=lambda: clock.mono))
    monkeypatch.setattr(wallets.threading, "Thread", DeferredThread)
    monkeypatch.setattr(wallets, "node_available", lambda: True)
    return clock, tasks


def test_deadline_is_anchored_and_idle_has_no_deadline(controlled, collector_guard):
    clock, tasks = controlled
    idle = wallets.collector_status()
    assert idle["deadline_at"] is None
    assert idle["timeout_seconds"] == 240
    assert idle["state"] == "IDLE"
    assert wallets.start_refresh("synthetic") is True
    started = wallets.collector_status()
    assert datetime.fromisoformat(started["deadline_at"]) - datetime.fromisoformat(started["last_started"]) == timedelta(seconds=240)
    clock.wall += 90
    clock.mono += 5
    assert wallets.collector_status() == started
    assert wallets.start_refresh("synthetic") is False
    tasks.pop()()
    argv, kwargs = collector_guard[0]
    assert argv == wallets.COLLECTOR_ARGV
    assert kwargs["timeout"] == 235
    assert kwargs["stdout"] == kwargs["stderr"] == wallets.subprocess.DEVNULL
    assert "capture_output" not in kwargs
    assert kwargs["shell"] is False
    finished = wallets.collector_status()
    assert finished["state"] == "SUCCEEDED"
    assert finished["deadline_at"] is None
    assert finished["last_started"] == started["last_started"]


def test_dirty_followup_coalesces_and_resets_attempt_only_when_it_starts(controlled, monkeypatch):
    clock, tasks = controlled
    attempts = []

    def run(_argv, **_kwargs):
        attempts.append(wallets.collector_status())
        if len(attempts) == 1:
            assert wallets.start_refresh("synthetic", changed=True) is False
            assert wallets.start_refresh("synthetic", changed=True) is False
            assert wallets.collector_status()["deadline_at"] == attempts[0]["deadline_at"]
            clock.wall += 30
            clock.mono += 30
            return SimpleNamespace(returncode=2)
        assert attempts[1]["state"] == "RUNNING"
        assert attempts[1]["last_error"] is None
        assert attempts[1]["last_exit"] is None
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(wallets.subprocess, "run", run)
    wallets.start_refresh("synthetic")
    tasks.pop()()
    assert len(attempts) == 2
    assert datetime.fromisoformat(attempts[1]["deadline_at"]) - datetime.fromisoformat(attempts[0]["deadline_at"]) == timedelta(seconds=30)
    assert wallets.collector_status()["state"] == "SUCCEEDED"


@pytest.mark.parametrize("code,error,state", [
    (0, None, "SUCCEEDED"), (1, "COLLECT_FAILED", "FAILED"),
    (2, "OUTPUT_BUSY", "DEFERRED"), (3, "TIMEOUT", "TIMEOUT"),
    (4, "OUTPUT_OWNERSHIP_LOST", "FAILED"), (5, "DRAIN_UNCONFIRMED", "FAILED"),
    (99, "COLLECT_FAILED", "FAILED"),
])
def test_fixed_exit_outcomes(controlled, monkeypatch, code, error, state):
    _, tasks = controlled
    monkeypatch.setattr(wallets.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=code, stdout=b"private", stderr=b"private"))
    wallets.start_refresh("synthetic")
    tasks.pop()()
    status = wallets.collector_status()
    assert status["last_exit"] == code
    assert status["last_error"] == error
    assert status["state"] == state
    assert status["deadline_at"] is None
    assert "private" not in str(status)
    if code == 2:
        assert "deferred" in wallets.collector_hint(status)
        assert "refreshed" not in wallets.collector_hint(status)


@pytest.mark.parametrize("exception,error", [
    (FileNotFoundError("private"), "NODE_NOT_FOUND"),
    (OSError("private"), "SPAWN_FAILED"),
    (wallets.subprocess.TimeoutExpired("private", 240), "TIMEOUT"),
])
def test_spawn_failures_are_fixed_codes(controlled, monkeypatch, exception, error):
    _, tasks = controlled

    def fail(*_args, **_kwargs):
        raise exception

    monkeypatch.setattr(wallets.subprocess, "run", fail)
    wallets.start_refresh("synthetic")
    tasks.pop()()
    status = wallets.collector_status()
    assert status["last_error"] == error
    assert status["running"] is False
    assert status["last_exit"] is None
    assert status["deadline_at"] is None
    assert "private" not in str(status)


def test_monotonic_timeout_prevents_launch_after_budget_even_if_wall_clock_rewinds(controlled, collector_guard):
    clock, tasks = controlled
    wallets.start_refresh("synthetic")
    clock.wall = -100000
    clock.mono = 240
    tasks.pop()()
    assert collector_guard == []
    assert wallets.collector_status()["state"] == "TIMEOUT"


@pytest.mark.parametrize("age,fresh", [
    (0, True), (900, True), (901, False), (-1, False),
    (float("nan"), False), (float("inf"), False), (float("-inf"), False), (None, False),
])
def test_freshness_requires_finite_nonfuture_age(controlled, age, fresh):
    _, tasks = controlled
    result = wallets.auto_refresh("synthetic", available=True, age=age)
    assert result["state"] == ("FRESH" if fresh else "STARTED")
    assert result["attempted"] is not fresh
    assert len(tasks) == (0 if fresh else 1)


def test_missing_snapshot_recovers_and_cooldown_singleflight_remain(controlled):
    _, tasks = controlled
    assert wallets.auto_refresh("synthetic", available=False, age=0)["state"] == "STARTED"
    assert wallets.auto_refresh("synthetic", available=False, age=None)["state"] == "RUNNING"
    assert len(tasks) == 1
    tasks.pop()()
    assert wallets.auto_refresh("synthetic", available=False, age=None)["state"] == "COOLDOWN"


def test_missing_node_does_not_launch(controlled, monkeypatch):
    _, tasks = controlled
    monkeypatch.setattr(wallets, "node_available", lambda: False)
    assert wallets.auto_refresh("synthetic", available=False, age=None)["state"] == "NODE_UNAVAILABLE"
    assert tasks == []


def test_collector_dto_remains_at_existing_wallets_path(root, client):
    status = get(client, "/api/v1/ops").get_json()["wallets"]["collector"]
    assert set(status) == {"running", "last_started", "last_finished", "last_exit", "last_error", "timeout_seconds", "deadline_at", "state"}
    assert status["timeout_seconds"] == 240
    assert status["deadline_at"] is None
