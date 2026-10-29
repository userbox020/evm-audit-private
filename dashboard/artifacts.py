"""Strict, bounded reads of the dashboard's fixed artifact allowlist."""

from __future__ import annotations

import json
import os
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator

from .target_indexes import TARGET_PATHS, TargetIndexRead, TargetJsonRead, TargetReader

MAX_BYTES = 5 * 1024 * 1024
MAX_LINE = 256 * 1024
MAX_EVENTS = 1000
TAIL_CHUNK = 64 * 1024
REPARSE_POINT = 0x400

ALLOWLIST = {
    "state": "reports/monitor/state.json",
    "alerts": "reports/monitor/alerts.jsonl",
    "venus_psr": "reports/monitor/venus-psr-state.json",
    "aave_v4": "reports/raw/fast/aave-v4-liquidation-watch.json",
    "aave_v3_liquidation_watch": "reports/raw/fast/aave-v3-liquidation-watch-status.json",
    "aave_v3_trigger_readiness": "reports/raw/fast/aave-v3-trigger-readiness.json",
    "aave_v3_liquidation_exact_quotes": "reports/raw/fast/aave-v3-liquidation-exact-quotes.json",
    "aave_v3_liquidation_trigger_quotes": "reports/raw/fast/aave-v3-liquidation-trigger-quotes.json",
    "aave_v3_borrower_universe": "reports/raw/fast/aave-v3-borrower-universe.json",
    "morpho_blue_liquidatable": "reports/raw/fast/morpho-blue-liquidatable.json",
    "morpho_blue_liquidatable_base": "reports/raw/fast/morpho-blue-liquidatable-base.json",
    "morpho_ws_status": "reports/monitor/morpho-ws-status.json",
    "euler_l_watch": "reports/raw/fast/euler-l-watch-status.json",
    "euler_l_surface": "reports/raw/fast/euler-l.json",
    "euler_l_valuation": "reports/raw/fast/euler-l-valuation.json",
    "research_watch": "reports/monitor/research-watch-state.json",
    "current_audit_state": "reports/monitor/current-audit-state.json",
    "stex_profit_trigger": "reports/monitor/stex-profit-trigger.json",
    "etherfi_debtmanager_profit_trigger": "reports/monitor/etherfi-debtmanager-profit-trigger.json",
    "lista_auction_incentive_profit_trigger": "reports/monitor/lista-auction-incentive-profit-trigger.json",
    "aave_v3_arbitrum_config_oracle_events": "reports/monitor/aave-v3-arbitrum-config-oracle-events.json",
    "trigger_watch_scheduler": "reports/monitor/trigger-watch-scheduler.json",
    "official_deployed_delta_sentinel": "reports/monitor/official-deployed-delta-sentinel.json",
    "ostium_deployment": "reports/raw/fast/ostium-stale-mark-deployment-step3.json",
    "ostium_settlement": "reports/raw/fast/ostium-stale-mark-settlement-step3b.json",
    "polymarket_r17": "reports/monitor/polymarket-r17-monitor.json",
    "polymarket_r19": "reports/monitor/polymarket-r19-monitor.json",
    "polymarket_r20": "reports/monitor/polymarket-r20-monitor.json",
    "base_paper_r8": "reports/raw/fast/base-paper-cycle-r8.json",
    "base_paper_r9": "reports/raw/fast/base-paper-usds-r9.json",
    "trigger_coverage_audit": "reports/monitor/trigger-coverage-audit.json",
    "profit_trigger_watch": "reports/monitor/profit-trigger-watch.json",
    "trigger_fork_autopilot_status": "reports/monitor/trigger-fork-autopilot-status.json",
    "trigger_fork_autopilot_state": "reports/monitor/trigger-fork-autopilot-state.json",
    "monitor_alert_dispatcher_status": "reports/monitor/monitor-alert-dispatcher-status.json",
    "monitor_set_watchdog_status": "reports/monitor/monitor-set-watchdog-status.json",
    "live_execution_batch": "coordination/live-execution-batch.json",
    "live_execution_approvers": "coordination/live-execution-approvers.json",
    "live_execution_batch_euler_trigger": "coordination/live-execution-batch-euler-trigger.json",
    "live_execution_batch_euler_trigger_2": "coordination/live-execution-batch-euler-trigger-2.json",
    "live_execution_batch_euler_trigger_3": "coordination/live-execution-batch-euler-trigger-3.json",
    "live_execution_batch_aave_trigger": "coordination/live-execution-batch-aave-trigger.json",
    "live_execution_batch_morpho_trigger": "coordination/live-execution-batch-morpho-trigger.json",
    "deployed_bytecode_verification": "reports/raw/fast/deployed-bytecode-verification.json",
    "silo_default_step1": "reports/raw/fast/silo-default-step1.json",
    "fluid_exit_depth": "reports/raw/fast/fluid-exit-depth/r1.json",
    "fluid_t2t4_rehearsal": "reports/raw/fast/fluid-t2t4-fork-rehearsal/result.json",
    "live_execution_batch_euler_fleet_2": "coordination/live-execution-batch-euler-fleet-2.json",
    "live_execution_batch_eth_bridge_scroll_retry": "coordination/live-execution-batch-eth-bridge-scroll-retry.json",
    "live_execution_batch_euler_autofire": "coordination/live-execution-batch-euler-autofire.json",
    "euler_fleet_deploy_status": "reports/raw/fast/euler-fleet-deploy-status.json",
    "autofire_loop_status": "reports/raw/fast/autofire-loop-status.json",
    "euler_fastlane_status": "reports/raw/fast/euler-fastlane-status.json",
    "silo_default_watch_status": "reports/raw/fast/silo-default-watch-status.json",
    "watch_addresses": "coordination/watch-addresses.json",
    "wallet_balances": "reports/monitor/wallet-balances.json",
    "exploit_rearm_canary": "reports/raw/fast/exploit-rearm-canary/status.json",
    "exploit_rearm_canary_history": "reports/raw/fast/exploit-rearm-canary/history.json",
    "exploit_rearm_canary_multichain": "reports/raw/fast/exploit-rearm-canary/status-multichain.json",
    "exploit_rearm_canary_multichain_history": "reports/raw/fast/exploit-rearm-canary/history-multichain.json",
    "oracle_divergence_monitor": "reports/raw/fast/exploit-rearm-canary/status-divergence.json",
    "oracle_divergence_monitor_history": "reports/raw/fast/exploit-rearm-canary/history-divergence.json",
    "canary_feeds_runner": "reports/monitor/canary-feeds/status.json",
    "exploit_rearm_canary_wallet_transactions": "reports/raw/fast/exploit-rearm-canary/wallet-transactions.json",
    "live_execution_batch_aave_v4_v3_morpho": "coordination/live-execution-batch-aave-v4-v3-morpho.json",
    "top_whale_triggers_status": "reports/raw/fast/top-whale-triggers-status.json",
    "m32_historical_local_rehearsal": "reports/raw/fast/executor-readiness-m32-20261026/m32-deployed-local-20261027T045710076Z.json",
    "aave_v4_v3_morpho_liquidator_deploy": "reports/raw/fast/aave-v4-v3-morpho-liquidator-deploy/result.json",
    "live_execution_batch_aave_v4_executor": "coordination/live-execution-batch-aave-v4-executor-deploy-20261019.json",
    "aave_v4_flash_liquidator_deploy": "reports/raw/fast/aave-v4-flash-liquidator-stage-20261019/mainnet-deployment-receipt.json",
    "aave_v4_executor_live_watch": "reports/raw/fast/aave-v4-executor-live-watch.json",
    "rank1_aave_v4_v2_watch": "reports/raw/fast/rank1-aave-v4-v2-watch.json",
    "top_whale_executor_live_watch": "reports/raw/fast/top-whale-executor-live-watch.json",
    "top_whale_executor_live_watch_2k_2l": "reports/raw/fast/top-whale-executor-live-watch-2k-2l.json",
    "aave_v4_multi_spoke_rehearsal": "reports/raw/fast/aave-v4-flash-liquidator-stage-20261019/fork-rehearsal-multi-spoke.json",
    "base_morpho_usde_rehearsal": "reports/raw/fast/fork-poc/verify-base-morpho-usde-liquidation.json",
    "eth_morpho_usde_dai_rehearsal": "reports/raw/fast/fork-poc/verify-eth-morpho-usde-dai-liquidation.json",
    "eth_morpho_reusd_rehearsal": "reports/raw/fast/fork-poc/verify-eth-morpho-reusd-usdc-liquidation.json",
    "eth_morpho_ynethx_rehearsal": "reports/raw/fast/fork-poc/verify-eth-morpho-ynethx-mseth-liquidation.json",
    "eth_morpho_pt_usde_rehearsal": "reports/raw/fast/fork-poc/verify-eth-morpho-pt-usde-dai-liquidation.json",
    "base_morpho_yousd_rehearsal": "reports/raw/fast/fork-poc/verify-base-yousd-usdc-liquidation.json",
    "new_whale_discoveries_rehearsal": "reports/raw/fast/fork-poc/verify-new-whale-discoveries.json",
    "base_morpho_liquidator_deploy": "reports/raw/fast/base-morpho-liquidator-stage-20261020/mainnet-deployment-receipt.json",
    "base_morpho_executor_live_watch": "reports/raw/fast/base-morpho-executor-live-watch.json",
    "arb_morpho_executor_live_watch": "reports/raw/fast/arb-morpho-executor-live-watch.json",
    "aave_v4_near_identities": "coordination/live-execution-batch-aave-v4-near-liquidation-20261019.json",
    **TARGET_PATHS,
}


@dataclass(frozen=True)
class JsonRead:
    """One immutable read result, including whether its value is current."""

    value: dict[str, Any] | None
    current: bool
    source: bool
    parser: bool
    cached: bool


def _is_reparse(info: os.stat_result) -> bool:
    """Return whether Windows marked a filesystem entry as a reparse point."""

    return bool(getattr(info, "st_file_attributes", 0) & REPARSE_POINT)


class ArtifactReader:
    """Read exact allowlisted files with synchronized, key-local caching."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root).resolve()
        self.last_good: dict[str, dict[str, Any]] = {}
        self.read_status: dict[str, dict[str, bool]] = {}
        self._lock = threading.RLock()
        self._target_reader = TargetReader(self.root, ALLOWLIST)

    def read_target_index(self, key: str) -> TargetIndexRead:
        """Read one fixed compact identity index, without last-good promotion."""

        return self._target_reader.read_index(key)

    def read_target_json(self, key: str, validator=None) -> TargetJsonRead:
        """Current-only JSON with fixed target-specific size exceptions."""

        return self._target_reader.read_json(key, validator)

    def target_fingerprint(self, key: str) -> tuple | None:
        """Securely reopen/revalidate one fixed source's metadata fingerprint."""

        return self._target_reader.fingerprint(key)

    def path(self, key: str) -> Path:
        """Return the fixed path for an allowlisted artifact key."""

        return self.root / ALLOWLIST[key]

    def _validated(self, key: str, allow_large: bool = False) -> tuple[Path, os.stat_result] | None:
        """Validate the exact path without following redirected components."""

        path = self.path(key)
        expected = Path(os.path.abspath(path))
        try:
            if path.resolve(strict=True) != expected:
                return None
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or _is_reparse(info):
                return None
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                return None
            if info.st_size > MAX_BYTES and not allow_large:
                return None
        except (OSError, RuntimeError):
            return None
        return path, info

    def _open(self, key: str, allow_large: bool = False) -> BinaryIO | None:
        """Open a file and verify the descriptor is the lstat-checked object."""

        validated = self._validated(key, allow_large=allow_large)
        if validated is None:
            return None
        path, before = validated

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor: int | None = None
        try:
            descriptor = os.open(path, flags)
            after = os.fstat(descriptor)
            if not os.path.samestat(before, after):
                raise OSError("artifact identity changed during open")
            if not stat.S_ISREG(after.st_mode) or _is_reparse(after) or after.st_nlink > 1:
                raise OSError("artifact is not a single-link regular file")
            if after.st_size > MAX_BYTES and not allow_large:
                raise OSError("artifact exceeds the read bound")
            stream = os.fdopen(descriptor, "rb")
            descriptor = None
            return stream
        except OSError:
            if descriptor is not None:
                os.close(descriptor)
            return None

    def _remember(self, key: str, result: JsonRead) -> JsonRead:
        self.read_status[key] = {
            "source": result.source,
            "parser": result.parser,
            "last_good": result.cached,
        }
        return result

    def read_json(
        self,
        key: str,
        validator: Callable[[dict[str, Any]], bool] | None = None,
    ) -> JsonRead:
        """Return a bounded JSON object and immutable current-read health."""

        with self._lock:
            stream = self._open(key)
            if stream is None:
                cached = self.last_good.get(key)
                return self._remember(
                    key,
                    JsonRead(cached, current=False, source=False, parser=False, cached=cached is not None),
                )

            try:
                with stream:
                    raw = stream.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise ValueError("artifact grew beyond the read bound")
                value = json.loads(raw.decode("utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("top-level JSON object required")
                if validator is not None and validator(value) is not True:
                    raise ValueError("artifact semantic validation failed")
            except (OSError, ValueError, UnicodeError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
                cached = self.last_good.get(key)
                return self._remember(
                    key,
                    JsonRead(cached, current=False, source=True, parser=False, cached=cached is not None),
                )

            self.last_good[key] = value
            return self._remember(
                key,
                JsonRead(value, current=True, source=True, parser=True, cached=False),
            )

    def json(self, key: str) -> dict[str, Any] | None:
        """Compatibility wrapper returning the current or cached value."""

        return self.read_json(key).value

    @staticmethod
    def _prepend_bounded(prefix: bytes, suffix: bytes, overlong: bool) -> tuple[bytes, bool]:
        if overlong or len(prefix) + len(suffix) > MAX_LINE:
            return b"", True
        return prefix + suffix, False

    @classmethod
    def _reverse_lines(
        cls,
        stream: BinaryIO,
        start: int,
        end: int,
        boundary_complete: bool,
    ) -> Iterator[tuple[bytes, bool]]:
        """Yield newline-delimited records newest first with bounded buffering."""

        position = end
        suffix = b""
        suffix_overlong = False
        while position > start:
            amount = min(TAIL_CHUNK, position - start)
            position -= amount
            stream.seek(position)
            chunk = stream.read(amount)
            parts = chunk.split(b"\n")
            if len(parts) == 1:
                suffix, suffix_overlong = cls._prepend_bounded(
                    parts[0], suffix, suffix_overlong
                )
                continue

            right, right_overlong = cls._prepend_bounded(
                parts[-1], suffix, suffix_overlong
            )
            yield right, right_overlong
            for line in reversed(parts[1:-1]):
                yield (b"", True) if len(line) > MAX_LINE else (line, False)
            suffix = parts[0] if len(parts[0]) <= MAX_LINE else b""
            suffix_overlong = len(parts[0]) > MAX_LINE

        if boundary_complete:
            yield suffix, suffix_overlong

    def jsonl(self) -> dict[str, Any]:
        """Reverse-scan enough of the bounded tail for 1000 newest records."""

        with self._lock:
            stream = self._open("alerts", allow_large=True)
            if stream is None:
                self.read_status["alerts"] = {
                    "source": False,
                    "parser": False,
                    "last_good": False,
                }
                return {"events": [], "malformed": 0, "current": False}

            newest: list[dict[str, Any]] = []
            malformed = 0
            try:
                with stream:
                    size = os.fstat(stream.fileno()).st_size
                    if size > MAX_BYTES:
                        # Reserve one byte of the I/O budget to determine
                        # whether the bounded window begins at a line boundary.
                        start = size - (MAX_BYTES - 1)
                        stream.seek(start - 1)
                        preceding = stream.read(1)
                        boundary_complete = preceding == b"\n"
                    else:
                        start = 0
                        boundary_complete = True

                    first = True
                    for line, overlong in self._reverse_lines(
                        stream, start, size, boundary_complete
                    ):
                        if first:
                            # Empty means the file ended in a newline. Any
                            # other value is an unterminated append and drops.
                            first = False
                            if not overlong and line == b"":
                                continue
                            continue
                        if overlong:
                            malformed += 1
                            continue
                        try:
                            row = json.loads(line.decode("utf-8"))
                        except (ValueError, UnicodeError, RecursionError):
                            malformed += 1
                            continue
                        if not isinstance(row, dict):
                            malformed += 1
                            continue
                        newest.append(row)
                        if len(newest) == MAX_EVENTS:
                            break
            except OSError:
                self.read_status["alerts"] = {
                    "source": True,
                    "parser": False,
                    "last_good": False,
                }
                return {"events": [], "malformed": 0, "current": False}

            self.read_status["alerts"] = {
                "source": True,
                "parser": malformed == 0,
                "last_good": False,
            }
            newest.reverse()
            return {"events": newest, "malformed": malformed, "current": True}
