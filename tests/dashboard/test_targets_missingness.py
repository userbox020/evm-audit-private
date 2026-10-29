"""Rendering-only missingness checks using isolated source fixtures."""

import copy
import importlib
import re
from html import unescape

import pytest

from conftest import get
from dashboard.targets import build_inventory, build_targets
from test_target_sources import Reader
from test_targets import NOW, SENTINEL, fixtures, iso, pin


def view(kind="position", data=None, ident=None):
    builder = build_inventory if kind == "market" else build_targets
    ident = ident or ("target-3-morpho-paxg-usdc" if kind == "market" else "target-m1-morpho-usde-dai")
    result = builder(Reader(fixtures() if data is None else data), NOW, {"q": ident})
    assert len(result["targets"]) == 1
    return result


@pytest.fixture
def render(client, monkeypatch):
    app_module = importlib.import_module("dashboard.app")

    def page(data):
        before = copy.deepcopy(data)
        inventory = data["view_mode"] == "historical_inventory"
        monkeypatch.setattr(app_module, "build_inventory" if inventory else "build_targets", lambda *args: data)
        response = get(client, "/inventory" if inventory else "/targets")
        assert response.status_code == 200
        assert data == before  # Display labels must not change the evidence.
        return response.get_data(as_text=True)

    return page


def text(markup):
    return " ".join(unescape(re.sub(r"<[^>]+>", "", markup)).split())


def field(markup, label):
    match = re.search(r"<dt>" + re.escape(label) + r"</dt><dd[^>]*>(.*?)</dd>", markup, re.S)
    assert match is not None, label
    return text(match.group(1))


def record(markup):
    return markup.split('<details class="t-target"', 1)[1].split("</details>", 1)[0]


def source_card(markup, source):
    return next(card for card in re.findall(r'<article class="t-source".*?</article>', markup, re.S)
                if f'<h3>{source["label"]}</h3>' in card)


@pytest.mark.parametrize("number", [None, 0, "0"])
def test_missing_amounts_and_counts_are_not_zero(render, number):
    data = view()
    row = data["targets"][0]
    row.update(health_factor=number, bps_numeric=number, health_is_estimate=False)
    row["position"].update(debt_amount=number, collateral_amount=number, borrow_apr_pct=number,
                           passive_hours=number, heartbeat_hours=number, is_estimate=False)
    row["quote"].update(available=True, gross_token_amount=number, gross_usd=number)
    source = next(s for s in data["coverage"]["sources"] if s["id"] == SENTINEL)
    source["input_rows"] = number
    html = render(data)
    details = record(html)
    for label, unit in [("Debt", "DAI"), ("Collateral", "USDe"), ("Borrow APR", "%"),
                        ("Passive crossing estimate", "hours"), ("Heartbeat estimate", "hours"),
                        ("Distance", "bps"), ("Gross token gain", "DAI"), ("Reported USD value", "USD")]:
        assert field(details, label) == ("Not reported" if number is None else f"0 {unit}")
    assert field(details, "Health factor") == ("Not reported" if number is None else "0")
    assert field(source_card(html, source), "Input rows") == ("Unknown" if number is None else "0")
    summary = text(details.split("</summary>", 1)[0])
    assert ("Passive est. · Not reported" if number is None else "Passive est. · 0 h") in summary
    if number is None:
        assert "0 DAI" not in summary and "0 USD" not in summary
    else:
        assert "0 DAI" in summary and "0 USD" in summary
    assert "means evidence is unavailable, not zero" in text(html)


@pytest.mark.parametrize("reported,armed,telemetry,target", [
    (None, None, "Unknown", "Unknown · not asserted"),
    (False, False, "No · telemetry only", "No"),
    (True, None, "Yes · telemetry only", "Unknown · not asserted"),
    (None, True, "Unknown", "Yes · not execution approval"),
    ("true", "true", "Unknown", "Unknown · not asserted"),
])
def test_reported_armed_never_promotes_target_armed(render, reported, armed, telemetry, target):
    data = view()
    row = data["targets"][0]
    row["runner"]["reported_armed"] = reported
    row["armed"] = armed
    details = record(render(data))
    assert field(details, "Reported armed") == telemetry
    assert field(details, "Target armed") == target
    assert "A reported mode or armed flag does not establish authorization, broadcast, or inclusion." in text(details)
    assert row["executable_now"] is False


def test_stale_source_and_quote_keep_original_times_separate_from_fresh_health(render):
    raw = fixtures()
    raw[SENTINEL]["generatedAt"] = iso(NOW - 4000)
    raw[SENTINEL]["pin"] = pin(age=4010)
    raw[SENTINEL]["targets"]["spokeC_AaveV4_weETH_WETH"][0]["liveQuote"]["observationUtc"] = iso(NOW - 4010)
    data = view(data=raw, ident="spoke-c-0")
    row = data["targets"][0]
    assert row["observation"]["freshness"] == "FRESH"
    assert row["quote"]["freshness"] == "STALE" and row["quote"]["available"] is False
    html = render(data)
    details = record(html)
    summary = text(details.split("</summary>", 1)[0])
    assert "Current quote unavailable" in summary and "Stale quote · block 1000" in summary
    assert "stored estimate, not earned" in summary
    quote_section = details.split("<h3>Current gross quote · pre-gas</h3>", 1)[1].split("</section>", 1)[0]
    assert field(quote_section, "Timestamp") == iso(NOW - 4010)
    source = next(s for s in data["coverage"]["sources"] if s["id"] == SENTINEL)
    assert source["freshness"] == "STALE"
    card = source_card(html, source)
    assert 'class="pill stale">Stale</span>' in card and source["age_text"] in card
    assert data["generated_at"] not in card  # Coverage has ages, not a source timestamp field.
    provenance = details.split("<h3>Stored source evidence</h3>", 1)[1].split("</section>", 1)[0]
    assert iso(NOW - 4000) in provenance and data["generated_at"] not in provenance
    missing = next(s for s in data["coverage"]["sources"] if s["read_state"] == "MISSING")
    missing_card = source_card(html, missing)
    assert 'class="pill unknown">Unknown</span>' in missing_card
    assert field(missing_card, "Input rows") == "Unknown"
    assert "Stale quote" not in missing_card


@pytest.mark.parametrize("kind", ["market", "position", "unspecified"])
@pytest.mark.parametrize("number", [None, 0])
def test_na_requires_market_schema_and_never_hides_known_zero(render, kind, number):
    data = view(kind)
    row = data["targets"][0]
    if kind == "unspecified":
        row.pop("record_type")
    # Missing borrower/runner alone must not turn a position into a market record.
    row.update(borrower_address=None, health_factor=number, bps_numeric=number, health_is_estimate=False)
    row["position"].update(debt_amount=number, debt_symbol="USDC", collateral_amount=number,
                           collateral_symbol="USDe", passive_hours=number, borrow_apr_pct=None,
                           heartbeat_hours=None, is_estimate=False)
    details = record(render(data))
    fallback = "Not applicable" if kind == "market" else "Not reported"
    for label, unit in [("Debt", "USDC"), ("Collateral", "USDe"), ("Distance", "bps"),
                        ("Passive crossing estimate", "hours")]:
        assert field(details, label) == (fallback if number is None else f"0 {unit}")
    assert field(details, "Health factor") == (fallback if number is None else "0")
    assert field(details, "Account / borrower") == ("Not applicable · market / vault record" if kind == "market" else "Not reported")
    # Market rates, oracle timing and runner evidence can be relevant; absence is not N/A.
    assert field(details, "Borrow APR") == field(details, "Heartbeat estimate") == "Not reported"
    assert "Not applicable" not in field(details, "Reported armed")
    assert "Not applicable" not in field(details, "Target armed")
    if kind == "market":
        assert field(details, "Configured implementation") == "Not reported"
        assert "Current quote unavailable" in details and "Liquidity ≠ profit" in details


def test_actual_armed_report_with_absent_quote_asserts_neither_readiness_nor_profit(render):
    raw = fixtures()
    raw[SENTINEL]["targets"]["targetM1_Morpho_USDe_DAI"].pop("liveQuote")
    data = view(data=raw)
    row = data["targets"][0]
    assert row["runner"]["reported_armed"] is True and row["armed"] is None
    assert row["quote"]["available"] is False and row["surplus_usd"] is None
    details = record(render(data))
    assert field(details, "Reported armed") == "Yes · telemetry only"
    assert field(details, "Target armed") == "Unknown · not asserted"
    assert "Current quote unavailable" in details and "No valid quote" in details
    assert "Stale quote" not in details and "modeled net" not in details
    assert "No target-bound realized-profit receipt is established by this page." in details
    assert "No signing, arming, or execution controls" in details
    assert row["executable_now"] is False
