import json
from types import SimpleNamespace

import pytest

import dashboard.wallets as wallets_module
from dashboard.app import create_app

@pytest.fixture
def root(tmp_path):
    for rel in ("reports/monitor", "reports/raw/fast", "coordination"):
        (tmp_path / rel).mkdir(parents=True, exist_ok=True)
    (tmp_path / "reports/monitor/state.json").write_text(json.dumps({"conditions": {}}), encoding="utf8")
    (tmp_path / "reports/monitor/alerts.jsonl").write_text("", encoding="utf8")
    for name in ("ostium-stale-mark-deployment-step3.json", "ostium-stale-mark-settlement-step3b.json"):
        (tmp_path / "reports/raw/fast" / name).write_text("{}", encoding="utf8")
    return tmp_path

@pytest.fixture
def client(root):
    # Cookie URL parsing rejects malformed Host fixtures before the request
    # reaches the application's own Host validator.
    return create_app(root).test_client(use_cookies=False)

@pytest.fixture(autouse=True)
def collector_guard(monkeypatch):
    """Reset the process-wide collector and never launch real node in tests."""

    wallets_module.reset_collector()
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((list(argv), kwargs))
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    monkeypatch.setattr(wallets_module.subprocess, "run", fake_run)
    yield calls
    wallets_module.reset_collector()

def get(client, url, **kw):
    return client.get(url, base_url="http://127.0.0.1:5050", environ_base={"REMOTE_ADDR":"127.0.0.1"}, **kw)

def post_json(client, url, payload, **kw):
    return client.post(
        url,
        base_url="http://127.0.0.1:5050",
        environ_base={"REMOTE_ADDR": "127.0.0.1"},
        json=payload,
        **kw,
    )
