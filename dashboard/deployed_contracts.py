"""Dated workspace deployments; no chain queries, collectors or evidence traversal."""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

from .jobs import CATALOG as JOB_CATALOG

CATALOG_PATH = Path(__file__).with_name("deployed_contracts_catalog.json")
JOB_SPECS = {spec["id"]: spec for spec in JOB_CATALOG}
KINDS = {"executor": "Executor", "helper": "Helper", "other": "Other contract"}
EVIDENCE = {"receipt_backed": "Receipt backed", "recorded_only": "Recorded only"}
READINESS = {"unknown": "Unknown", "held": "Held", "disabled": "Disabled"}
EXPLORERS = {
    1: ("Ethereum", "https://etherscan.io"),
    8453: ("Base", "https://basescan.org"),
    42161: ("Arbitrum", "https://arbiscan.io"),
    10: ("Optimism", "https://optimistic.etherscan.io"),
    137: ("Polygon", "https://polygonscan.com"),
    56: ("BNB Chain", "https://bscscan.com"),
    43114: ("Avalanche", "https://snowtrace.io"),
    534352: ("Scroll", "https://scrollscan.com"),
    42220: ("Celo", "https://celoscan.io"),
    84532: ("Base Sepolia", "https://sepolia.basescan.org"),
}
IDENTIFIER = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}")


def _text(value: Any) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _unique(values: list[Any]) -> list[Any]:
    result = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def _strings(value: Any) -> list[str]:
    return _unique([item for raw in _list(value) if (item := _text(raw))])


def _identifier(value: Any) -> str | None:
    return value if isinstance(value, str) and IDENTIFIER.fullmatch(value) else None


def _integer(value: Any, low: int, high: int = 9_007_199_254_740_991) -> int | None:
    return value if type(value) is int and low <= value <= high else None


def _hex(value: Any, length: int) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{%d}" % length, value) else None


def _address(value: Any) -> str | None:
    address = _hex(value, 40)
    return address if address and int(address[2:], 16) else None


def _dated(value: Any, *, timestamp: bool = False) -> str | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        if not timestamp and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            date.fromisoformat(value)
        else:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None or parsed.year < 2000:
                return None
        return value
    except (ValueError, OverflowError):
        return None


def _notes(*values: Any) -> str | None:
    return " ".join(_unique([text for value in values if (text := _text(value))])) or None


def _record(raw: Any) -> dict[str, Any] | None:
    raw = _mapping(raw)
    chain = _integer(raw.get("chain_id"), 1)
    address = _address(raw.get("address"))
    kind = raw.get("kind")
    deployment = _mapping(raw.get("deployment"))
    status = deployment.get("status")
    if (raw.get("deployment_scope") not in ("workspace_live", "workspace_testnet")
            or chain is None or address is None
            or not isinstance(kind, str) or kind not in KINDS
            or not isinstance(status, str) or status not in EVIDENCE):
        return None
    ownership = _mapping(raw.get("ownership"))
    code = _mapping(raw.get("code"))
    readiness = _mapping(raw.get("readiness"))
    state = readiness.get("state")
    valid_state = isinstance(state, str) and state in READINESS
    state = state if valid_state else "unknown"
    evidence = []
    for item in _list(raw.get("evidence")):
        item = _mapping(item)
        path = _text(item.get("path"))
        if path:
            lines = item.get("lines")
            evidence.append({"path": path, "lines": _text(lines) or _integer(lines, 1),
                             "note": _text(item.get("note"))})
    runners = []
    for item in _list(raw.get("runners")):
        if isinstance(item, dict):
            runners.append({"job_id": _identifier(item.get("job_id")),
                            "label": _text(item.get("label")),
                            "script_id": item.get("script_id") if isinstance(item.get("script_id"), str) else None,
                            "note": _text(item.get("note"))})
    return {
        "id": _identifier(raw.get("id")) or f"contract-{chain}-{address.lower()[2:]}",
        "name": _text(raw.get("name")) or "Unnamed contract",
        "aliases": _strings(raw.get("aliases")), "kind": kind, "kind_label": KINDS[kind],
        "chain_id": chain, "chain_name": _text(raw.get("chain_name")) or EXPLORERS.get(chain, (None,))[0],
        "address": address, "purpose": _text(raw.get("purpose")),
        "protocols": _strings(raw.get("protocols")), "funding": _text(raw.get("funding")),
        "capabilities": _strings(raw.get("capabilities")), "source_paths": _strings(raw.get("source_paths")),
        "deployment": {
            "status": status, "label": _text(deployment.get("label")) or EVIDENCE[status],
            "tx_hash": _hex(deployment.get("tx_hash"), 64),
            "block_number": _integer(deployment.get("block_number"), 0),
            "observed_at": _dated(deployment.get("observed_at")),
            "gas_used": str(deployment["gas_used"]) if re.fullmatch(r"[0-9]+", str(deployment.get("gas_used"))) else None,
            "note": _text(deployment.get("note")),
        },
        "ownership": {"owner_address": _address(ownership.get("owner_address")),
                      "access": _text(ownership.get("access")), "upgradeability": _text(ownership.get("upgradeability"))},
        "code": {"runtime_hash": _hex(code.get("runtime_hash"), 64),
                 "verification": _text(code.get("verification")), "compiler": _text(code.get("compiler"))},
        "runners": runners,
        "readiness": {"state": state, "label": (_text(readiness.get("label")) if valid_state else None) or READINESS[state],
                      "note": _text(readiness.get("note")) if valid_state else "Execution readiness is not established."},
        "blockers": _strings(raw.get("blockers")), "evidence": _unique(evidence),
    }


def _merge(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    def strength(row: dict[str, Any]) -> tuple[bool, bool, bool]:
        deployment = row["deployment"]
        return (deployment["status"] == "receipt_backed", deployment["tx_hash"] is not None,
                deployment["block_number"] is not None)

    preferred, other = (second, first) if strength(second) > strength(first) else (first, second)
    merged = dict(preferred)
    for key in ("protocols", "capabilities", "source_paths", "blockers", "evidence", "runners"):
        merged[key] = _unique(first[key] + second[key])
    merged["aliases"] = [name for name in _unique(first["aliases"] + second["aliases"] + [first["name"], second["name"]])
                         if name != merged["name"]]
    for key in ("purpose", "funding", "chain_name"):
        merged[key] = preferred[key] or other[key]
    for key in ("ownership", "code"):
        merged[key] = {field: value if value is not None else other[key][field]
                       for field, value in preferred[key].items()}
    # Keep receipt facts together rather than mixing a weaker record's transaction/block.
    merged["deployment"] = dict(preferred["deployment"], note=_notes(first["deployment"]["note"], second["deployment"]["note"]))
    return merged


def _runners(bindings: list[dict[str, Any]], snapshot: Any) -> list[dict[str, Any]]:
    snapshot = _mapping(snapshot)
    observed = _dated(snapshot.get("observedAt"), timestamp=True)
    fresh = (snapshot.get("freshness") == "FRESH" and observed is not None
             and _mapping(snapshot.get("inspection")).get("processes") == "OK")
    jobs: dict[str, Any] = {}
    for row in _list(snapshot.get("jobs")):
        row = _mapping(row)
        ident = _identifier(row.get("id"))
        if ident:
            jobs[ident] = None if ident in jobs else row
    unique: dict[tuple[Any, Any], dict[str, Any]] = {}
    for binding in bindings:
        key = (binding["job_id"], binding["script_id"])
        if key in unique:
            unique[key]["note"] = _notes(unique[key]["note"], binding["note"])
            unique[key]["label"] = unique[key]["label"] or binding["label"]
        else:
            unique[key] = dict(binding)
    result = []
    for binding in unique.values():
        ident = binding["job_id"]
        runner = dict(binding, state="UNMAPPED", pids=[], observed_at=None, match_kind="NONE", url=None)
        spec = JOB_SPECS.get(ident)
        # The curated binding contains a path; the sanitized snapshot contains a job ID.
        # Match both identities exactly, without accepting aliases or guessing filenames.
        if spec and spec.get("script") and binding["script_id"] == spec["script"]:
            job = jobs.get(ident)
            runner.update(state="UNKNOWN", observed_at=observed, url=f"#job-{ident}")
            if spec.get("aliases"):
                # In particular, top-whale-trigger-executor also matches its read-only
                # watcher. The snapshot cannot identify which script supplied a PID.
                runner["note"] = _notes(runner["note"], "Job inspection combines script aliases; executor-specific process activity is unknown.")
            else:
                proc = _mapping(job.get("process")) if job and job.get("scriptId") == ident else {}
                pids = proc.get("pids")
                match = proc.get("matchKind")
                if (fresh and proc.get("state") == "RUNNING" and isinstance(pids, list)
                        and 0 < len(pids) <= 128
                        and all(_integer(pid, 1, 4_294_967_295) is not None for pid in pids)
                        and match in ("WORKSPACE_PATH", "SCRIPT_MATCH")):
                    runner.update(state="RUNNING", pids=sorted(set(pids)), match_kind=match)
                    if match == "SCRIPT_MATCH":
                        runner["note"] = _notes(runner["note"], "SCRIPT_MATCH: script-only match; workspace identity is not confirmed.")
                elif fresh and proc.get("state") == "NOT_RUNNING" and pids == [] and match == "NONE":
                    runner["state"] = "NOT_RUNNING"
        if runner["state"] == "UNMAPPED":
            runner["note"] = _notes(runner["note"], "No exact registered job/script binding; process state is not inferred.")
        result.append(runner)
    return result


def _search(value: Any) -> str:
    if isinstance(value, dict):
        return " ".join(_search(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_search(item) for item in value)
    return "" if value is None else str(value)


def build_deployed_contracts(jobs_snapshot: Any, args: Any = None) -> dict[str, Any]:
    """Project one bundled catalog and the caller's already-sanitized Jobs snapshot."""
    try:
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        if not isinstance(catalog, dict) or not isinstance(catalog.get("contracts"), list):
            raise ValueError("invalid catalog")
    except (OSError, ValueError, UnicodeError, RecursionError):
        catalog = {"contracts": [], "coverage": {"summary": "Deployed contract catalog unavailable.",
                   "gaps": ["The bundled catalog could not be read; no deployment coverage is asserted."]}}
    coverage_raw = _mapping(catalog.get("coverage"))
    coverage = {"summary": _text(coverage_raw.get("summary")) or "Workspace-recorded deployments, not a live chain inventory.",
                "exclusions": _strings(coverage_raw.get("exclusions")), "gaps": _strings(coverage_raw.get("gaps"))}
    by_address = {}
    rejected = 0
    for raw in catalog["contracts"]:
        row = _record(raw)
        if row is None:
            rejected += 1
            continue
        key = (row["chain_id"], row["address"].lower())
        by_address[key] = _merge(by_address[key], row) if key in by_address else row
    if rejected:
        coverage["exclusions"].append(f"{rejected} invalid or out-of-scope catalog record(s) excluded.")
    rows = list(by_address.values())
    for row in rows:
        base = EXPLORERS.get(row["chain_id"], (None, None))[1]
        row["explorer_url"] = f"{base}/address/{row['address']}" if base else None
        tx_hash = row["deployment"]["tx_hash"]
        row["deployment"]["tx_url"] = f"{base}/tx/{tx_hash}" if base and tx_hash else None
        row["runners"] = _runners(row["runners"], jobs_snapshot)
    args = args if args is not None else {}
    filters = {key: str(args.get(key, "")) for key in ("contract_q", "contract_chain", "contract_kind", "contract_evidence")}
    filters["contract_q"] = filters["contract_q"].strip()[:200]
    query = filters["contract_q"].casefold()
    matched = [row for row in rows
               if (not filters["contract_chain"] or str(row["chain_id"]) == filters["contract_chain"])
               and (not filters["contract_kind"] or row["kind"] == filters["contract_kind"])
               and (not filters["contract_evidence"] or row["deployment"]["status"] == filters["contract_evidence"])
               and (not query or query in _search(row).casefold())]
    chains = {str(row["chain_id"]): row["chain_name"] or f"Chain {row['chain_id']}" for row in rows}
    return {
        "catalog_as_of": _dated(catalog.get("catalog_as_of")), "read_only": True, "live_chain_checked_at": None,
        "summary": {"total": len(rows), "matched": len(matched),
                    "executors": sum(row["kind"] == "executor" for row in rows),
                    "other_contracts": sum(row["kind"] != "executor" for row in rows),
                    "receipt_backed": sum(row["deployment"]["status"] == "receipt_backed" for row in rows),
                    "recorded_only": sum(row["deployment"]["status"] == "recorded_only" for row in rows),
                    "chains": len(chains)},
        "filters": filters,
        "options": {"chains": [{"value": value, "label": label} for value, label in sorted(chains.items(), key=lambda pair: pair[1])],
                    "kinds": [{"value": value, "label": label} for value, label in KINDS.items()],
                    "evidence": [{"value": value, "label": label} for value, label in EVIDENCE.items()]},
        "contracts": matched, "coverage": coverage, "notices": _strings(catalog.get("notices")),
    }
