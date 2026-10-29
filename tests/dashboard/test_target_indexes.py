"""Offline fixed-source reader fixtures only; no collectors or external IO."""

import hashlib
import importlib
import json
import os
import sys
from dataclasses import FrozenInstanceError, fields
from pathlib import Path
from types import SimpleNamespace

import pytest

from dashboard.artifacts import ALLOWLIST, MAX_BYTES, ArtifactReader, JsonRead, TargetIndexRead, TargetJsonRead
import dashboard.target_indexes as indexes


def address(n):
    return "0x" + format(n, "040x")


def block_hash(n):
    return "0x" + format(n, "064x")


def pair(n, market=1):
    return block_hash(market) + "0x" + "0" * 24 + address(n)[2:]


def write(root, key, value):
    path = root / ALLOWLIST[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(value, dict):
        value = json.dumps(value, indent=2).encode()
    elif isinstance(value, str):
        value = value.encode()
    path.write_bytes(value)
    return path


def morpho(chain=1, pairs=None):
    return {"schema": "morpho-blue-l-index/v1", "chainId": chain, "version": 1,
            "deploymentBlock": 18883124 if chain == 1 else 13977148, "cursor": 26200000, "logs": 2,
            "pairs": pairs if pairs is not None else {pair(1): 1, pair(2): 1},
            "evaluation": {"evaluatedAt": "2026-10-19T23:00:00.000Z", "activeKeys": [], "assumedZero": 2}}


SPOKES = [
    "0x3131fe68c4722e726fe6b2819ed68e514395b9a4", "0x58131e79531cab1d52301228d1f7b842f26b9649",
    "0x65407b940966954b23dfa3caa5c0702bb42984dc", "0x774b9655413c34809c1f1b16b654465a89ebe989",
    "0x7ec68b5695e803e98a21a9a05d744f28b0a7753d", "0x94e7a5dcbe816e498b89ab752661904e2f56c485",
    "0x956d8e0a89cfa3744428c4641b5a53b56167a7f9", "0x973a023a77420ba610f06b3858ad991df6d85a08",
    "0xad75ce6354f87f3135ce10621d385d8d1e2562c2", "0xba1b3d55d249692b669a164024a838309b7508af",
    "0xbf10bdfe177de0336afd7fccf80a904e15386219", "0xd8b93635b8c6d0ff98cbe90b5988e3f2d1cd9da1",
    "0xe1900480ac69f0b296841cd01cc37546d92f35cd",
]


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def v4():
    identity = {"chainId": 1, "fromBlock": 0, "borrowTopic": indexes.V4_TOPIC,
                "registryDigest": "8b293b95955a2431bd7516abcbf52f5466ddd0b9340074b6222c5db2e507ef40", "spokes": SPOKES}
    assert digest(identity) == indexes.V4_IDENTITY_DIGEST
    users = {spoke: [] for spoke in SPOKES}
    users[SPOKES[0]] = [{"user": address(1), "firstBorrowBlock": 1, "lastBorrowBlock": 2, "borrowEvents": 3}]
    data = {"schema": "aave-v4-borrower-history/v1", "identity": identity, "identityDigest": digest(identity),
            "throughBlock": 100, "throughBlockHash": block_hash(100), "committedChunks": 1, "logs": 3, "users": users}
    return {"index": data, "contentDigest": digest(data)}


AAVE_HEADER = "user,lastBorrowBlock\n"
EULER_HEADER = "vault,liquidator,violator,collateralAsset,repayAssetsRaw,yieldBalanceRaw,blockNumber,txHash,logIndex\n"


def euler_row(n=1):
    return f"{address(10)},{address(20)},{address(n)},{address(30)},123,456,100,{block_hash(1)},2\n"


def test_exact_api_registration_and_frozen_results(root):
    reader = ArtifactReader(root)
    assert set(indexes.TARGET_PATHS) == {
        "aave_v3_borrower_csv", "aave_v4_borrower_index", "morpho_blue_index", "morpho_blue_base_index", "euler_liquidation_history",
        "aave_v4_near_watch", "aave_v3_route_distance", "aave_v4_spoke_borrowers", "compound_v3_base_watch",
        "euler_silo_current_screen", "silo_l_surface", "silo_l_economics"}
    assert all(ALLOWLIST[key] == path for key, path in indexes.TARGET_PATHS.items())
    assert [f.name for f in fields(TargetIndexRead)] == ["entries", "current", "read_state", "input_rows", "accepted_rows", "rejected_rows",
        "omitted_rows", "truncated", "generated_at", "fingerprint", "max_bytes", "max_rows"]
    assert [f.name for f in fields(TargetJsonRead)] == ["value", "current", "read_state", "fingerprint", "max_bytes"]
    result = reader.read_target_index("aave_v3_borrower_csv")
    assert (result.current, result.read_state, result.input_rows, result.omitted_rows) == (False, "MISSING", None, None)
    with pytest.raises(FrozenInstanceError):
        result.current = True


@pytest.mark.parametrize("key,chain", [("morpho_blue_index", 1), ("morpho_blue_base_index", 8453)])
def test_morpho_compact_identities_are_not_activity_or_health_claims(root, key, chain):
    write(root, key, morpho(chain))
    reader = ArtifactReader(root)
    result = reader.read_target_index(key)
    assert result.current and result.read_state == "OK"
    assert result.entries == ((chain, "Morpho Blue", indexes.MORPHO, address(1), block_hash(1)),
                              (chain, "Morpho Blue", indexes.MORPHO, address(2), block_hash(1)))
    assert (result.input_rows, result.accepted_rows, result.rejected_rows, result.omitted_rows) == (2, 2, 0, 0)
    assert result.generated_at == "2026-10-19T23:00:00Z"
    assert result.fingerprint == reader.target_fingerprint(key)
    assert len(result.fingerprint) == 5 and all(type(n) is int for n in result.fingerprint)
    assert reader.last_good == {}


@pytest.mark.parametrize("change", [
    lambda d: d.update(schema="other"), lambda d: d.update(chainId=8453), lambda d: d.update(chainId=True),
    lambda d: d.update(version=2), lambda d: d.update(deploymentBlock=1), lambda d: d.update(cursor="26200000"),
    lambda d: d.update(pairs=[]), lambda d: d.update(logs=-1),
])
def test_morpho_wrong_scope_schema_and_types_are_invalid(root, change):
    data = morpho(); change(data); write(root, "morpho_blue_index", data)
    result = ArtifactReader(root).read_target_index("morpho_blue_index")
    assert not result.current and result.read_state == "INVALID" and result.entries == ()
    assert result.input_rows is None


def test_morpho_canonical_padding_addresses_and_event_counts_reject_rows_visibly(root):
    pairs = {pair(1): 1, block_hash(1) + "0x1" + "0" * 23 + address(2)[2:]: 1,
             pair(0): 1, pair(3).replace("0x", "0X"): 1, pair(4)[:-1]: 1,
             pair(5): -1, pair(6): True, pair(7): "1", pair(8): 0, pair(9): 1.5}
    write(root, "morpho_blue_index", morpho(pairs=pairs))
    result = ArtifactReader(root).read_target_index("morpho_blue_index")
    assert result.current and result.read_state == "PARTIAL"
    assert (result.input_rows, result.accepted_rows, result.rejected_rows, result.omitted_rows) == (10, 1, 9, 0)


def test_v4_validates_producer_compact_digest_not_pretty_file_hash(root):
    data = v4(); path = write(root, "aave_v4_borrower_index", data)
    assert hashlib.sha256(path.read_bytes()).hexdigest() != data["contentDigest"]
    result = ArtifactReader(root).read_target_index("aave_v4_borrower_index")
    assert result.current and result.read_state == "OK"
    assert result.entries == ((1, "Aave V4", SPOKES[0], address(1), None),)
    assert result.generated_at is None


@pytest.mark.parametrize("mutation", ["content", "identity", "chain", "spokes", "schema", "users", "logs", "header", "extra"])
def test_v4_wrapper_scope_digest_and_cross_counters_fail_closed(root, mutation):
    data = v4()
    if mutation == "content":
        data["contentDigest"] = "0" * 64
    else:
        if mutation == "identity": data["index"]["identityDigest"] = "0" * 64
        if mutation == "chain": data["index"]["identity"]["chainId"] = 8453
        if mutation == "spokes": data["index"]["identity"]["spokes"] = [address(22)]
        if mutation == "schema": data["index"]["schema"] = "other"
        if mutation == "users": data["index"]["users"][address(21)] = []
        if mutation == "logs": data["index"]["logs"] = 99
        if mutation == "header": data["index"]["throughBlockHash"] = "bad"
        if mutation == "extra": data["index"]["extra"] = "PRIVATE_NOT_FOR_OUTPUT"
        data["contentDigest"] = digest(data["index"])
    write(root, "aave_v4_borrower_index", data)
    result = ArtifactReader(root).read_target_index("aave_v4_borrower_index")
    assert not result.current and result.read_state == "INVALID" and result.entries == ()
    assert "PRIVATE" not in repr(result)


def test_v4_row_rejections_are_counted_without_loosening_digest(root):
    data = v4(); row = data["index"]["users"][SPOKES[0]][0]
    data["index"]["users"][SPOKES[0]].extend([{**row, "user": "bad"}, {**row, "borrowEvents": True}, row.copy()])
    data["contentDigest"] = digest(data["index"])
    write(root, "aave_v4_borrower_index", data)
    result = ArtifactReader(root).read_target_index("aave_v4_borrower_index")
    assert result.current and result.read_state == "PARTIAL"
    assert (result.input_rows, result.accepted_rows, result.rejected_rows) == (4, 1, 3)


def test_csv_fixed_pool_typed_euler_fields_no_mtime_dates_or_event_dedup(root):
    write(root, "aave_v3_borrower_csv", AAVE_HEADER + f"{address(1)},999999999999\n{address(2)},3\n")
    write(root, "euler_liquidation_history", EULER_HEADER + euler_row() * 2)
    reader = ArtifactReader(root)
    aave, euler = reader.read_target_index("aave_v3_borrower_csv"), reader.read_target_index("euler_liquidation_history")
    assert aave.entries[0] == (1, "Aave V3", indexes.AAVE_POOL, address(1), None)
    assert aave.generated_at is None and euler.generated_at is None
    assert euler.accepted_rows == 2 and euler.entries[0] == euler.entries[1] == (1, "Euler", address(10), address(1), None)


@pytest.mark.parametrize("key,raw", [
    ("aave_v3_borrower_csv", "borrower,lastBorrowBlock\n"), ("aave_v3_borrower_csv", "x" * 257 + "\n"),
    ("euler_liquidation_history", EULER_HEADER.rstrip() + ",extra\n"),
    ("euler_liquidation_history", EULER_HEADER.replace("violator", "borrower")),
    ("euler_liquidation_history", "x" * 1025 + "\n"), ("aave_v3_borrower_csv", b"\xff\n"),
])
def test_csv_exact_headers_and_header_line_bounds(root, key, raw):
    write(root, key, raw)
    result = ArtifactReader(root).read_target_index(key)
    assert not result.current and result.read_state == "INVALID" and result.input_rows is None


def test_csv_overlong_malformed_and_invalid_utf8_rows_are_explicit_partial(root):
    raw = (AAVE_HEADER + f"{address(1)},1\n" + "x" * 1000 + "\n" + f"{address(2)},1e3\n" + f"{address(0)},1\n").encode() + b"\xff,2\n"
    write(root, "aave_v3_borrower_csv", raw)
    result = ArtifactReader(root).read_target_index("aave_v3_borrower_csv")
    assert result.current and result.read_state == "PARTIAL"
    assert (result.input_rows, result.accepted_rows, result.rejected_rows) == (5, 1, 4)
    write(root, "euler_liquidation_history", EULER_HEADER + euler_row() + euler_row().replace(",123,", ",1.2,") + "x" * 1025 + "\n")
    result = ArtifactReader(root).read_target_index("euler_liquidation_history")
    assert (result.input_rows, result.accepted_rows, result.rejected_rows) == (3, 1, 2)


def test_index_row_caps_report_exact_omissions_and_do_not_use_old_10000_limit(root):
    write(root, "aave_v3_borrower_csv", AAVE_HEADER + f"{address(1)},1\n" * 125001)
    result = ArtifactReader(root).read_target_index("aave_v3_borrower_csv")
    assert result.current and result.read_state == "PARTIAL" and result.truncated
    assert (result.input_rows, result.accepted_rows, result.omitted_rows) == (125001, 125000, 1)
    write(root, "morpho_blue_index", morpho(pairs={pair(n): 1 for n in range(1, 10002)}))
    result = ArtifactReader(root).read_target_index("morpho_blue_index")
    assert result.read_state == "OK" and result.accepted_rows == 10001
    write(root, "euler_liquidation_history", EULER_HEADER + euler_row() * 10001)
    result = ArtifactReader(root).read_target_index("euler_liquidation_history")
    assert (result.accepted_rows, result.omitted_rows, result.truncated) == (10000, 1, True)


@pytest.mark.parametrize("key", list(indexes.INDEX_LIMITS))
def test_fixed_byte_bounds_reject_before_read_and_invalidate_cache(root, key):
    path = write(root, key, b"")
    with path.open("wb") as stream:
        stream.truncate(indexes.INDEX_LIMITS[key][0] + 1)
    reader = ArtifactReader(root)
    result = reader.read_target_index(key)
    assert not result.current and result.read_state == "OVERSIZED" and result.fingerprint is None
    assert reader.target_fingerprint(key) is None and result.entries == () and result.input_rows is None


def test_target_json_only_eth_morpho_has_16m_exception_and_never_promotes_cached_values(root):
    reader = ArtifactReader(root)
    raw = b'{"padding":"' + b"x" * MAX_BYTES + b'"}'
    path = write(root, "morpho_blue_liquidatable", raw)
    result = reader.read_target_json("morpho_blue_liquidatable")
    assert result.current and result.max_bytes == 16777216
    assert not reader.read_json("morpho_blue_liquidatable").current
    assert "morpho_blue_liquidatable" not in reader.last_good
    write(root, "morpho_blue_liquidatable_base", raw)
    assert reader.read_target_json("morpho_blue_liquidatable_base").read_state == "OVERSIZED"
    path.write_text("{", encoding="utf-8")
    failed = reader.read_target_json("morpho_blue_liquidatable")
    assert not failed.current and failed.value is None and failed.read_state == "INVALID"
    path.unlink()
    assert reader.read_target_json("morpho_blue_liquidatable").read_state == "MISSING"


def test_current_only_json_validation_is_sanitized_and_old_jsonread_semantics_unchanged(root):
    reader = ArtifactReader(root)
    path = write(root, "compound_v3_base_watch", {"ok": True})
    current = reader.read_target_json("compound_v3_base_watch", validator=lambda value: value["ok"])
    assert current.current and current.value == {"ok": True}
    assert reader.last_good == {}
    old = reader.read_json("compound_v3_base_watch")
    assert isinstance(old, JsonRead) and old.current
    path.write_text("{", encoding="utf-8")
    assert reader.read_json("compound_v3_base_watch").value == {"ok": True}
    failed = reader.read_target_json("compound_v3_base_watch")
    assert failed.value is None and not failed.current
    write(root, "compound_v3_base_watch", {"ok": True})
    def validator(_value):
        raise RuntimeError("PRIVATE_UNTRUSTED_VALIDATOR")
    failed = reader.read_target_json("compound_v3_base_watch", validator)
    assert failed.read_state == "INVALID" and "PRIVATE" not in repr(failed)
    assert reader.jsonl()["current"] is True


def test_cache_hits_securely_open_and_ttl_forces_parse(root, monkeypatch):
    write(root, "morpho_blue_index", morpho())
    reader = ArtifactReader(root)
    tick, parsed, opened = [0], [], []
    parse, open_file = indexes._parse_index, reader._target_reader._open
    monkeypatch.setattr(indexes.time, "monotonic", lambda: tick[0])
    def counted(key, raw):
        parsed.append(key)
        return parse(key, raw)
    def counted_open(key, limit):
        opened.append(key)
        return open_file(key, limit)
    monkeypatch.setattr(indexes, "_parse_index", counted)
    monkeypatch.setattr(reader._target_reader, "_open", counted_open)
    first = reader.read_target_index("morpho_blue_index")
    tick[0] = 59
    assert reader.read_target_index("morpho_blue_index") is first
    tick[0] = 60
    assert reader.read_target_index("morpho_blue_index") is not first
    assert len(parsed) == 2 and len(opened) == 3
    assert reader.last_good == {}


def test_modified_replaced_removed_corrupt_and_oversized_inputs_never_reuse_compact_cache(root):
    key = "morpho_blue_index"
    path = write(root, key, morpho()); reader = ArtifactReader(root)
    first = reader.read_target_index(key)
    path.write_text(json.dumps(morpho(pairs={pair(9): 1})), encoding="utf-8")
    second = reader.read_target_index(key)
    assert second.fingerprint != first.fingerprint and second.entries[0][3] == address(9)
    replacement = path.with_suffix(".replacement")
    replacement.write_text(json.dumps(morpho(pairs={pair(10): 1})), encoding="utf-8")
    os.replace(replacement, path)
    third = reader.read_target_index(key)
    assert third.entries[0][3] == address(10) and third.fingerprint != second.fingerprint
    path.write_text("{", encoding="utf-8")
    assert reader.read_target_index(key).read_state == "INVALID" and key not in reader._target_reader._cache
    write(root, key, morpho()); assert reader.read_target_index(key).current
    with path.open("wb") as stream: stream.truncate(indexes.INDEX_LIMITS[key][0] + 1)
    assert reader.target_fingerprint(key) is None and key not in reader._target_reader._cache
    failed = reader.read_target_index(key)
    assert not failed.current and failed.entries == () and failed.read_state == "OVERSIZED"
    path.unlink()
    assert reader.read_target_index(key).read_state == "MISSING"


@pytest.mark.parametrize("changes,expected", [(1, "OK"), (2, "UNAVAILABLE")])
def test_inplace_change_during_parse_retries_once_then_fails_closed(root, monkeypatch, changes, expected):
    key = "aave_v3_borrower_csv"
    path = write(root, key, AAVE_HEADER + f"{address(1)},1\n")
    reader = ArtifactReader(root); original = indexes._parse_index; calls = []
    def changing(key, raw):
        calls.append(key)
        result = original(key, raw)
        if len(calls) <= changes:
            path.write_text(AAVE_HEADER + f"{address(len(calls) + 1)},1\n", encoding="utf-8")
            info = path.stat(); os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
        return result
    monkeypatch.setattr(indexes, "_parse_index", changing)
    result = reader.read_target_index(key)
    assert len(calls) == 2 and result.read_state == expected
    if changes == 1:
        assert result.entries[0][3] == address(2)
    else:
        assert not result.current and not result.entries and result.fingerprint is None


def test_json_change_during_validator_retries_with_current_value(root):
    key = "compound_v3_base_watch"; path = write(root, key, {"version": 1}); calls = []
    def validator(value):
        calls.append(value["version"])
        if value["version"] == 1:
            path.write_text(json.dumps({"version": 22}), encoding="utf-8")
        return True
    result = ArtifactReader(root).read_target_json(key, validator)
    assert calls == [1, 22] and result.current and result.value == {"version": 22}


def test_hardlinks_and_reparse_components_invalidate_even_cached_reads(root, monkeypatch):
    key = "aave_v3_borrower_csv"; path = write(root, key, AAVE_HEADER + f"{address(1)},1\n")
    reader = ArtifactReader(root); assert reader.read_target_index(key).current
    other = path.with_suffix(".link")
    os.link(path, other)
    assert reader.target_fingerprint(key) is None and reader.read_target_index(key).read_state == "UNAVAILABLE"
    other.unlink(); assert reader.read_target_index(key).current
    lstat = indexes.os.lstat
    def reparse(file, *args, **kwargs):
        info = lstat(file, *args, **kwargs)
        if Path(file) == path.parent:
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=indexes.REPARSE_POINT)
        return info
    monkeypatch.setattr(indexes.os, "lstat", reparse)
    assert reader.target_fingerprint(key) is None
    result = reader.read_target_index(key)
    assert not result.current and result.read_state == "UNAVAILABLE" and result.entries == ()


def test_symlink_leaf_never_redirects_reads(root):
    key = "aave_v3_borrower_csv"; path = write(root, key, AAVE_HEADER)
    other = path.with_suffix(".target"); path.rename(other)
    try:
        path.symlink_to(other)
    except OSError:
        pytest.skip("OS does not permit creating a symlink")
    reader = ArtifactReader(root)
    assert reader.target_fingerprint(key) is None and reader.read_target_index(key).read_state == "UNAVAILABLE"


def test_descriptor_identity_change_is_retried_boundedly_and_descriptors_close(root, monkeypatch):
    write(root, "aave_v3_borrower_csv", AAVE_HEADER)
    reader = ArtifactReader(root); fstat = indexes.os.fstat; descriptors = []
    def changed(fd):
        descriptors.append(fd); info = list(fstat(fd)); info[1] += 1
        return os.stat_result(info)
    monkeypatch.setattr(indexes.os, "fstat", changed)
    result = reader.read_target_index("aave_v3_borrower_csv")
    assert result.read_state == "UNAVAILABLE" and len(descriptors) == 2
    for fd in descriptors:
        with pytest.raises(OSError): fstat(fd)


def test_readonly_fixed_keys_no_caller_paths_limits_or_parser_redirects(root, monkeypatch):
    reader = ArtifactReader(root); calls = []; original = indexes.os.open
    def readonly(path, flags, *args, **kwargs):
        assert not flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
        calls.append(path); return original(path, flags, *args, **kwargs)
    monkeypatch.setattr(indexes.os, "open", readonly)
    for key in ["../state", "reports/monitor/state.json", "unknown", None]:
        assert reader.read_target_index(key).read_state == "INVALID"
        assert reader.read_target_json(key).read_state == "INVALID"
        assert reader.target_fingerprint(key) is None
    assert not calls
    for key in indexes.INDEX_LIMITS:
        assert reader.read_target_json(key).read_state == "INVALID"
    assert reader.read_target_index("state").read_state == "INVALID"
    assert reader.read_target_json("state").current
    assert len(calls) == 1
    with pytest.raises(TypeError): reader.read_target_json("state", max_bytes=100000000)


def test_json_duplicate_keys_nonfinite_and_bad_utf8_fail_without_cached_promotion(root):
    reader = ArtifactReader(root)
    for raw in [b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":"\xff"}', b'[]']:
        write(root, "compound_v3_base_watch", raw)
        result = reader.read_target_json("compound_v3_base_watch")
        assert not result.current and result.read_state == "INVALID" and result.value is None


def test_target_module_import_is_inert(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("UNEXPECTED_IO")
    with monkeypatch.context() as context:
        context.setattr(os, "open", forbidden)
        context.setattr(Path, "read_bytes", forbidden)
        context.setattr(Path, "read_text", forbidden)
        name = "dashboard._target_indexes_import_probe"
        spec = importlib.util.spec_from_file_location(name, indexes.__file__)
        module = importlib.util.module_from_spec(spec)
        context.setitem(sys.modules, name, module)
        spec.loader.exec_module(module)
        assert module.TargetIndexRead.__dataclass_params__.frozen
