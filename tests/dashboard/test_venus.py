from copy import deepcopy

from dashboard.artifacts import ArtifactReader
from dashboard.service import snapshot, venus_state_valid
from test_dashboard import venus_state
from conftest import get


def test_legacy_venus_is_presented_as_single_provider(root, client):
    venus_state(root)
    data = snapshot(ArtifactReader(root), now=1001)
    rows = [row for row in data["monitors"] if row["id"].startswith("venus-psr-")]
    assert len(rows) == 3
    for row in rows:
        assert row["rpc_strength"] == "single-provider"
        assert row["current_block"] == 11
        assert any("independent corroboration is not established" in message for message in row["warnings"])
    assert "Single-provider evidence; not independently corroborated." in get(client, "/").get_data(as_text=True)


def test_venus_rejects_strength_inflation_and_accepts_explicit_strength(root):
    state = venus_state(root)
    for row in state["chains"].values():
        row["current"]["rpcStrength"] = "single-provider"
        row["lastSuccessfulObservation"]["rpcStrength"] = "single-provider"
    assert venus_state_valid(state)
    for field in ("current", "lastSuccessfulObservation"):
        invalid = deepcopy(state)
        invalid["chains"]["ethereum"][field]["rpcStrength"] = "corroborated"
        assert not venus_state_valid(invalid)
