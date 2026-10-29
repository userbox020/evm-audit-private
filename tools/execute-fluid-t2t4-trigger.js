#!/usr/bin/env node
"use strict";
// execute-fluid-t2t4-trigger.js
// Trigger-gated signing runner for the deployed Fluid Vault T2/T4 flash liquidator
// `FltLiquidateT2T4` (contracts/flash-liquidate-fluid-t2t4/).
//
// NOT INTEGRATED YET: the executor has no mainnet deployment, so EXECUTOR defaults
// to the zero placeholder and the runner refuses at gate "0" (executor-not-deployed)
// before any network call. Pass --executor <address> only AFTER the executor is
// deployed and verified (tools/verify-deployed-bytecode.js FLUID-T2T4 entry).
//
// Fail-closed end to end. Every precondition is evaluated in order and logged as a
// gate BEFORE any key read or network write. If any gate is not satisfied the runner
// prints an honest gate table and exits {"ok":false,"reason":"execution-needs-live-trigger-state"}
// without reading a key file and without sending. Private key material is read from
// gated env files only in --execute mode, only after every gate passes; it stays
// in-process and is never printed, hashed, persisted, or passed on a command line.
// Endpoint material (URL/host/path) is never printed or persisted.
//
// SAFE BLOCK (2026-10-13): gate "c" (gateRehearsal) is a deliberate, temporary
// fail-closed block. The standing rehearsal harness is mock-driven and does not bind
// a real candidate/chain/pin/size/quote/net to the real executor, so gate c refuses
// unconditionally — there is NO live success path in this patch. Candidate
// eligibility is shared with gate b via isEligibleRow so the no-feasible-row
// diagnostic is complete offline without live network.
//
// Mirrors tools/execute-euler-evk-trigger.js for batch gating, key loading, keyless
// RPC qualification, nonce/chainId/fee handling, the bounded candidate feasibility
// loop, and the receipt poll. Row source (Fluid):
//   * reports/raw/fast/fluid-l-economics.json — `routePositive:true` rows (the
//     vault's own oracle-priced would-be liquidations), each carrying an `exitDepth`
//     block (or sourced from reports/raw/fast/fluid-exit-depth/r1.json when present);
//   * reports/raw/fast/fluid-l-watch-status.json — optional watcher artifact; when
//     absent the watcher gate is SKIPPED HONESTLY (never fabricated).
//
// The executor surface (onlyOwner) is the single tuple call:
//   execute((address vault,uint8 vaultType,address debtToken,uint256 debtAmt,
//            uint256 token0DebtAmt,uint256 token1DebtAmt,uint256 debtSharesMin,
//            uint256 colPerUnitDebt,bool exitIsToken0,address exitToken,
//            uint256 colAmtPerUnitShares,bool absorb,uint256 minOut,
//            uint256 minProfitWei,address router,bytes routerSwapData))
// per contracts/flash-liquidate-fluid-t2t4/src/FltLiquidateT2T4.sol:257-281.
//
// CLI: --dry-run (default) | --execute

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Interface, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
// Lane overrides: --batch <path> --executor <addr> --outdir <name> --deploy-block <n>
// Fail-closed defaults keep the lane semantics explicit.
const __triggerArgv = process.argv.slice(2);
function __triggerArg(flag, fallback) {
  const i = __triggerArgv.indexOf(flag);
  return i !== -1 && __triggerArgv[i + 1] ? __triggerArgv[i + 1] : fallback;
}
const BUNDLE = path.resolve(ROOT, __triggerArg("--batch", "coordination/live-execution-batch-fluid-t2t4-trigger.json"));
const WATCH_STATUS = path.join(ROOT, "reports", "raw", "fast", "fluid-l-watch-status.json");
const ECONOMICS = path.join(ROOT, "reports", "raw", "fast", "fluid-l-economics.json");
const EXIT_DEPTH = path.join(ROOT, "reports", "raw", "fast", "fluid-exit-depth", "r1.json");
// tools/fluid-t2t4-flash-rehearsal.js writes OUTPUT to
// reports/raw/fast/fluid-t2t4-fork-rehearsal/result.json (state PASS|FAIL_CLOSED).
const REHEARSAL = path.join(ROOT, "reports", "raw", "fast", "fluid-t2t4-fork-rehearsal", "result.json");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", __triggerArg("--outdir", "fluid-t2t4-liquidation-execution"));
const ENV_FILES = [path.join(ROOT, ".env"), path.join(ROOT, ".env.exploit")];
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
// PLACEHOLDER_UNDEPLOYED: no Fluid executor deployment exists yet. Gate "0" refuses
// until --executor is passed after deploy + bytecode verification.
const EXECUTOR_PLACEHOLDER = "0x0000000000000000000000000000000000000000";
const EXECUTOR = getAddress(__triggerArg("--executor", EXECUTOR_PLACEHOLDER));

const FRESH_WATCH_MS = 5 * 60 * 1000;
const FRESH_ECONOMICS_MS = 10 * 60 * 1000;
const FRESH_REHEARSAL_MS = 10 * 60 * 1000;
const MIN_OUT_HAIRCUT_BPS = 98n; // minOut floor = quoted * 0.98

// Flash-source funding precheck: the Balancer Vault must hold >= debtAmt of the
// debt asset (BAL#528 = INSUFFICIENT_FLASH_LOAN_BALANCE during its loan leg).
const BALANCER_VAULT = getAddress("0xBA12222222228d8Ba445958a75a0704d566BF2C8");
const MAX_ROW_PROBES = 3; // bounded per-candidate probes per firing attempt
const ERC20_IFACE = new Interface(["function balanceOf(address) view returns (uint256)"]);

// Exact executor surface (FltLiquidateT2T4.sol:257-281). `owner()` is declared only
// so the module's gate exports stay self-describing; it is never called.
const EXEC_PARAMS_TUPLE =
  "(address,uint8,address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,bool,uint256,uint256,address,bytes)";
const EXEC_IFACE = new Interface([
  `function execute(${EXEC_PARAMS_TUPLE}) external`,
  "function owner() view returns (address)",
  "event LiquidationExecuted(address vault,uint8 vaultType,address debtToken,uint256 debtLiquidated,uint256 colSharesLiquidated,uint256 exitOut,uint256 swapOut,uint256 netProfitWei)",
]);

// Live liveness: Fluid liquidations are aggregate-tick and racey. The vault's own
// `simulateLiquidate(uint256,bool)` reverts with `FluidLiquidateResult(col,debt)`
// (the canonical in-tree max-liquidatable probe used by the fork rehearsal); that
// revert IS the liquidate-preceded state read. A row that reverts otherwise, or
// reports debt == 0, is already eaten/unliquidatable and is skipped fail-closed.
const LIQ_SIM_IFACE = new Interface([
  "function simulateLiquidate(uint256 maxAmount_, bool absorb_)",
  "error FluidLiquidateResult(uint256 colLiquidated, uint256 debtLiquidated)",
  "error FluidVaultError(uint256 id)",
]);

async function readVaultLiquidatable(provider, vault, rpcFn) {
  const rpc = rpcFn || rpcOn;
  try {
    await rpc(provider, "eth_call", [{ to: getAddress(vault), data: LIQ_SIM_IFACE.encodeFunctionData("simulateLiquidate", [0, false]) }, "latest"]);
    // Returned without revert: no liquidatable balance at the probe.
    return { liquidatable: false, reason: "simulateLiquidate-returned", debtLiquidated: 0n };
  } catch (err) {
    const data = err && err.revertData ? err.revertData : null;
    if (data) {
      try {
        const p = LIQ_SIM_IFACE.parseError(data);
        if (p && p.name === "FluidLiquidateResult") {
          const col = BigInt(p.args[0]);
          const debt = BigInt(p.args[1]);
          return { liquidatable: debt > 0n, reason: `FluidLiquidateResult(col=${col},debt=${debt})`, colLiquidated: col, debtLiquidated: debt };
        }
        if (p && p.name === "FluidVaultError") {
          return { liquidatable: false, reason: `FluidVaultError(${p.args[0]})`, debtLiquidated: 0n };
        }
      } catch (_) { /* fall through */ }
    }
    // Unreadable / unexpected -> fail closed (never assume liquidatable).
    return { liquidatable: false, reason: "liveness-unreadable:" + sanitize(err && err.message ? err.message : String(err)).slice(0, 60), debtLiquidated: null };
  }
}

async function readBalancerBalance(provider, token, rpcFn) {
  const rpc = rpcFn || rpcOn;
  const raw = await rpc(provider, "eth_call", [{
    to: getAddress(token),
    data: ERC20_IFACE.encodeFunctionData("balanceOf", [BALANCER_VAULT]),
  }, "latest"]);
  return typeof raw === "string" && raw.length > 2 ? BigInt(raw) : null;
}

function fail(code) { console.log(JSON.stringify({ ok: false, reason: code })); process.exit(1); }
function sanitize(v) { return typeof v === "string" ? v.replaceAll(/[0-9a-fA-F]{64}/g, "<64hex>") : v; }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function lc(s) { return String(s || "").toLowerCase(); }
function toBig(value) { try { return value === null || value === undefined || value === "" ? null : BigInt(value); } catch (_) { return null; } }
function toNum(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

function tryReadJson(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false, ok: false, value: null };
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) {
    return { exists: true, ok: false, value: null };
  }
}

function ageMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : null;
}

async function rpcOn(url, method, params) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15_000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: c.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const b = await r.json();
    if (b.error) {
      const err = new Error("rpc:" + (b.error.message || "").slice(0, 40));
      const data = typeof b.error.data === "string" ? b.error.data : b.error.data?.data;
      if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) err.revertData = data.toLowerCase();
      throw err;
    }
    if (b.result === undefined) throw new Error("rpc-shape-failure");
    return b.result;
  } finally { clearTimeout(t); }
}

function isQuantity(v) { return typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v); }
function isHash(v) { return typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v); }

function loadRpcUrls() {
  // Align the candidate pool with the workspace's shared-rpc ranked loader (the
  // same pool every working tool uses). Security posture unchanged: qualify()
  // still enforces chainId 0x1, finalized hash recheck, and live executor code,
  // all fail-closed. The endpoint value is process-only, never printed/persisted.
  try { return require("./shared-rpc").loadRpcUrls({ maxCandidates: 40 }); } catch (_) { return []; }
}

async function qualify() {
  for (const url of loadRpcUrls()) {
    let chainId, finalized, recheck, code;
    try { chainId = await rpcOn(url, "eth_chainId", []); } catch (_) { continue; }
    if (chainId !== "0x1") continue;
    try { finalized = await rpcOn(url, "eth_getBlockByNumber", ["finalized", false]); } catch (_) { continue; }
    if (!finalized || !isHash(finalized.hash) || !isQuantity(finalized.number)) continue;
    try { recheck = await rpcOn(url, "eth_getBlockByNumber", [finalized.number, false]); } catch (_) { continue; }
    if (!recheck || recheck.hash !== finalized.hash) continue;
    try { code = await rpcOn(url, "eth_getCode", [EXECUTOR, "latest"]); } catch (_) { continue; }
    if (typeof code !== "string" || code.length <= 2) continue;
    return url;
  }
  return fail("no-qualified-provider");
}

// Same gated key-file pattern as the euler trigger runner. Only ever invoked in
// --execute after every gate has passed.
function loadPrivateKey() {
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(?:[A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})\s*(?:#.*)?$/);
      if (!m) continue;
      try {
        const wallet = new Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1]);
        if (wallet.address.toLowerCase() === MAIN_ACCOUNT.toLowerCase()) return m[1].startsWith("0x") ? m[1] : "0x" + m[1];
      } catch (_) { continue; }
    }
  }
  return fail("key-file-unavailable");
}

// ---- exit-depth normalization -------------------------------------------------
// The economics rows embed an `exitDepth` block (flat outQuoted/netAtQuotedSize);
// the standalone reports/raw/fast/fluid-exit-depth/r1.json rows carry venues with
// `quotedOutAtSizes`. Both are normalized to { source, outQuoted, netAtQuotedSize }.
// r1.json is PREFERRED when it has a matching vault row.
function normalizeExitDepth(depth, sourceLabel) {
  if (!depth || typeof depth !== "object") return null;
  if (typeof depth.outQuoted === "string") {
    return {
      source: sourceLabel,
      state: depth.state || null,
      outQuoted: toBig(depth.outQuoted),
      netAtQuotedSize: toBig(depth.netAtQuotedSize),
      executable: depth.executableAtQuotedSize === true,
    };
  }
  if (Array.isArray(depth.venues)) {
    const venue = depth.venues.find(v => Array.isArray(v.quotedOutAtSizes) && v.quotedOutAtSizes.length);
    if (!venue) return null;
    const outs = venue.quotedOutAtSizes.map(p => toBig(p.amountOut)).filter(x => x !== null);
    const outQuoted = outs.length ? outs.reduce((a, b) => (b > a ? b : a), 0n) : null;
    return { source: sourceLabel, state: depth.state || null, outQuoted, netAtQuotedSize: null, executable: depth.executableAfterSizing === true };
  }
  return null;
}

function loadExitDepthRows() {
  const map = new Map();
  const r = tryReadJson(EXIT_DEPTH);
  if (r.exists && r.ok && Array.isArray(r.value.rows)) {
    for (const row of r.value.rows) {
      if (row && typeof row.vault === "string") map.set(lc(row.vault), row);
    }
  }
  return map;
}

function pickExitDepth(row, depthRows) {
  const embedded = row.exitDepth && typeof row.exitDepth === "object"
    ? normalizeExitDepth(row.exitDepth, "reports/raw/fast/fluid-l-economics.json#exitDepth")
    : null;
  const standaloneRaw = depthRows.get(lc(row.vault));
  const standalone = standaloneRaw
    ? normalizeExitDepth(standaloneRaw, `reports/raw/fast/fluid-exit-depth/r1.json#${lc(row.vault)}`)
    : null;
  // Quote source: prefer the standalone r1.json row when present, else the embedded block.
  const quote = standalone && standalone.outQuoted !== null ? standalone : embedded;
  if (!quote) return null;
  return {
    source: quote.source,
    state: quote.state !== null ? quote.state : (embedded ? embedded.state : null),
    outQuoted: quote.outQuoted,
    // The strict (gas + full-debt inclusive) net is only carried by the economics
    // exit-depth block; keep it regardless of which source supplied the quote.
    netAtQuotedSize: embedded ? embedded.netAtQuotedSize : null,
    executable: quote.executable,
  };
}

// ---- shared eligibility (used by gate b AND main, BEFORE any sort/truncate) ----
// A route-positive row is only a probe candidate when ALL of these hold:
//   * chainId is the numeric Ethereum chain id 1 (missing/unparseable fails closed);
//   * the parsed/sized exit-depth output is a positive BigInt (unsized rows never
//     enter the bounded probe budget);
//   * the debt token is delivered by the row's OWN exit pool (colToken0/colToken1);
//   * depth.executable === true (a sizing ESTIMATE, never an authorization).
// Pure. `depth` must be the output of the exact `pickExitDepth` above (no mimic);
// `depth.executable` reflects the artifact's estimate flags only.
function parseChainId(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) return Number(s);
    if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s, 16);
  }
  return null;
}

function isEligibleRow(row, depth) {
  if (!row || typeof row !== "object") return { ok: false, reason: "row-unavailable" };
  const chainId = parseChainId(row.chainId);
  if (chainId === null) return { ok: false, reason: "chainId-missing" };
  if (chainId !== 1) return { ok: false, reason: `chainId-not-ethereum(${chainId})` };
  if (!depth || typeof depth !== "object") return { ok: false, reason: "exit-depth-unsized" };
  if (depth.outQuoted === null || depth.outQuoted === undefined || depth.outQuoted <= 0n) return { ok: false, reason: "exit-depth-unsized" };
  if (depth.executable !== true) return { ok: false, reason: "exit-depth-not-executable" };
  const deliversDebt = lc(row.colToken0) === lc(row.debtToken) || lc(row.colToken1) === lc(row.debtToken);
  if (!deliversDebt) return { ok: false, reason: "debt-token-not-in-exit-pool" };
  return { ok: true, reason: "eligible", chainId };
}

function rowNet(row, depth) {
  return depth && depth.netAtQuotedSize !== null ? depth.netAtQuotedSize : (toBig(row.netUsdc) ?? 0n) - (toBig(row.gasBoundUsdc) ?? 0n);
}

// Pure selection for the bounded probe loop: keep only eligible route-positive rows
// (shared helper, applied BEFORE sort/truncate so ineligible top-net rows can never
// starve an eligible one), order by net descending, cap at MAX_ROW_PROBES, and retain
// the ineligible reasons with full vault + chainId so the no-feasible-row diagnostic
// needs no live network.
function selectProbeRows(rows, depthRows) {
  const list = Array.isArray(rows) ? rows : [];
  const rejected = [];
  const eligible = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    if (row.routePositive !== true) continue;
    if (!row.vault || !row.debtToken) {
      rejected.push({ vault: row.vault ? lc(row.vault) : null, chainId: parseChainId(row.chainId), skip: "vault-or-debt-token-missing" });
      continue;
    }
    const depth = pickExitDepth(row, depthRows || new Map());
    const el = isEligibleRow(row, depth);
    if (!el.ok) {
      rejected.push({ vault: lc(row.vault), chainId: parseChainId(row.chainId), skip: el.reason });
      continue;
    }
    eligible.push({ row, depth, net: rowNet(row, depth) });
  }
  eligible.sort((a, b) => (a.net < b.net ? 1 : a.net > b.net ? -1 : 0));
  return { eligible: eligible.slice(0, MAX_ROW_PROBES), rejected, eligibleTotal: eligible.length };
}

// ---- preconditions (all must pass, in order, before any key/network call) ----

// 0. executor deployed: the placeholder must be replaced after deploy+verify.
function gateDeployed(executor) {
  const ex = executor || EXECUTOR;
  if (ex === EXECUTOR_PLACEHOLDER) {
    return { ok: false, detail: `executor-not-deployed:${ex} (pass --executor <address> after deploy + verify-deployed-bytecode.js FLUID-T2T4)` };
  }
  return { ok: true, detail: `executor=${ex}` };
}

// a. batch approved / unexpired / account matches MAIN / triggerGated block present.
function gateBatch(io) {
  const readJson = (io && io.readJson) || tryReadJson;
  const r = readJson(BUNDLE);
  if (!r.exists) return { ok: false, detail: `batch-missing:${rel(BUNDLE)}` };
  if (!r.ok) return { ok: false, detail: "batch-unreadable-or-invalid-json" };
  const b = r.value;
  if (b.approved !== true) return { ok: false, detail: "batch-not-approved" };
  const exp = Date.parse(b.expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, detail: "batch-expiresAt-unparseable" };
  if (exp < Date.now()) return { ok: false, detail: "batch-expired" };
  if (String(b.account?.address || "").toLowerCase() !== MAIN_ACCOUNT) return { ok: false, detail: "batch-account-mismatch" };
  if (!b.triggerGated || typeof b.triggerGated !== "object" || !Array.isArray(b.triggerGated.requiredBeforeSignedTx)) {
    return { ok: false, detail: "triggerGated-block-missing" };
  }
  return { ok: true, detail: `approved batchId=${b.batchId} expiresAt=${b.expiresAt}`, batch: b };
}

// b. fresh trigger surface:
//    * optional watcher: fresh fluid-l-watch-status.json (<=5m) with live candidates
//      when present; when ABSENT the watcher gate is skipped honestly (never faked);
//    * fresh fluid-l-economics.json (<=10m) with >=1 routePositive row carrying a
//      sized exit-depth block (a route-positive row with no exit depth is not
//      fireable and is never fabricated); highest net row is selected.
function gateFreshTrigger(io) {
  const readJson = (io && io.readJson) || tryReadJson;
  const depthRowsFn = (io && io.depthRows) || loadExitDepthRows;
  const notes = [];

  // --- optional watcher ---
  const w = readJson(WATCH_STATUS);
  if (!w.exists) {
    notes.push(`watcher-gate-skipped:${rel(WATCH_STATUS)}-absent`);
  } else if (!w.ok) {
    return { ok: false, detail: "watch-status-unreadable-or-invalid-json" };
  } else {
    const wAge = ageMs(w.value.generatedAt);
    if (wAge === null) return { ok: false, detail: "watch-status-generatedAt-unparseable" };
    if (wAge > FRESH_WATCH_MS) return { ok: false, detail: `watch-status-stale:${Math.round(wAge / 1000)}s>${FRESH_WATCH_MS / 1000}s` };
    if (wAge < -60_000) return { ok: false, detail: "watch-status-generatedAt-in-future" };
    if (w.value.ok !== true) return { ok: false, detail: `watch-status-not-ok:${w.value.reason || w.value.ok}` };
    const t = w.value.totals || {};
    const liveCandidates = toNum(t.violatorChecksLiquidatable) > 0 || toNum(t.violatorChecksHealthy) > 0;
    if (!liveCandidates) return { ok: false, detail: `watch-status-no-live-candidates:liquidatable=${t.violatorChecksLiquidatable ?? null},healthy=${t.violatorChecksHealthy ?? null}` };
    notes.push(`watch live(liquidatable=${t.violatorChecksLiquidatable ?? 0},healthy=${t.violatorChecksHealthy ?? 0}) age=${Math.round(wAge / 1000)}s`);
  }

  // --- economics rows ---
  const e = readJson(ECONOMICS);
  if (!e.exists) return { ok: false, detail: `economics-missing:${rel(ECONOMICS)}` };
  if (!e.ok) return { ok: false, detail: "economics-unreadable-or-invalid-json" };
  const eAge = ageMs(e.value.generatedAt);
  if (eAge === null) return { ok: false, detail: "economics-generatedAt-unparseable" };
  if (eAge > FRESH_ECONOMICS_MS) return { ok: false, detail: `economics-stale:${Math.round(eAge / 1000)}s>${FRESH_ECONOMICS_MS / 1000}s` };
  if (eAge < -60_000) return { ok: false, detail: "economics-generatedAt-in-future" };

  const depthRows = depthRowsFn();
  const rows = Array.isArray(e.value.rows) ? e.value.rows : [];
  const routePositive = rows.filter(r => r && r.routePositive === true);

  // Eligibility uses the SAME pure helper as main (chainId 1 + positive sized depth +
  // debt token delivered by the row's own exit pool + executable estimate), applied
  // before the net ordering. Ineligible rows are recorded with their reason so the
  // refusal carries the full eligibility trace.
  let chosen = null;
  const candidates = [];
  for (const row of routePositive) {
    if (!row.vault || !row.debtToken) {
      candidates.push({ vault: row.vault ? lc(row.vault) : null, chainId: parseChainId(row.chainId), skip: "vault-or-debt-token-missing" });
      continue;
    }
    const depth = pickExitDepth(row, depthRows);
    const el = isEligibleRow(row, depth);
    if (!el.ok) {
      candidates.push({ vault: lc(row.vault), chainId: parseChainId(row.chainId), skip: el.reason });
      continue;
    }
    const net = rowNet(row, depth);
    if (!chosen || net > chosen.net) chosen = { row, net, depth };
  }
  if (!chosen) {
    const reasons = candidates.map(c => `${c.vault ?? "?"}/${c.chainId ?? "?"}:${c.skip}`).join(",");
    return { ok: false, detail: `economics-no-eligible-exitDepth-row:rows=${rows.length},routePositive=${routePositive.length},reasons=[${sanitize(reasons).slice(0, 400)}]` };
  }
  notes.push(`economics routePositive=${routePositive.length} eligible depthSrc=${chosen.depth.source} topNet=${chosen.net} age=${Math.round(eAge / 1000)}s`);
  return { ok: true, detail: notes.join("; "), row: chosen.row, depth: chosen.depth, net: chosen.net, candidates, economics: e.value };
}

// c. fork rehearsal gate — TEMPORARY SAFE BLOCK (fail-closed; no live success path).
//
// The standing rehearsal harness (tools/fluid-t2t4-flash-rehearsal.js) is
// mock-driven and does NOT bind a real candidate/chain/pin/size/quote/net to the
// real executor surface. Until that real-candidate proof exists, this gate refuses
// UNCONDITIONALLY:
//   * a mock PASS (summary.modes includes MOCK_DRIVEN, or row provenance indicates
//     mock) is never live proof;
//   * a missing / unknown / bare generic `state === "PASS"` MUST NOT bypass;
//   * a hypothetical unbound "real" label is not accepted either — there is no real
//     proof schema implemented in this patch, and no acceptance is fabricated from
//     new metadata.
// This is a deliberate, documented safe block. It does not redesign authorization,
// and no live success path is added here.
function gateRehearsal(io) {
  const readJson = (io && io.readJson) || tryReadJson;
  const r = readJson(REHEARSAL);
  if (!r.exists) return { ok: false, detail: `rehearsal-result-missing:${rel(REHEARSAL)}` };
  if (!r.ok) return { ok: false, detail: "rehearsal-result-unreadable-or-invalid-json" };
  const a = r.value || {};
  const s = a.summary || {};
  const modes = Array.isArray(s.modes) ? s.modes.map(String) : (Array.isArray(a.modes) ? a.modes.map(String) : []);
  const rows = Array.isArray(a.rows) ? a.rows : (Array.isArray(s.rows) ? s.rows : []);
  const mockRow = rows.some(row => row && typeof row === "object"
    && (row.provenance === "mock" || row.mock === true || row.mode === "MOCK_DRIVEN" || row.mockDriven === true));
  const mockDriven = modes.some(m => /MOCK_DRIVEN/i.test(m)) || mockRow;
  if (mockDriven) {
    return { ok: false, detail: `rehearsal-mock-driven-not-live-proof:modes=[${modes.join(",")}],mockRow=${mockRow}` };
  }
  const stateLabel = a.state === undefined ? "absent" : String(a.state);
  return { ok: false, detail: `rehearsal-real-candidate-proof-unavailable:fail-closed state=${stateLabel},summary.pass=${s.pass ?? null},summary.failClosed=${s.failClosed ?? null} (no candidate/chain/pin/size/quote/net real-executor binding; mock or generic PASS never bypasses)` };
}

// d. economics floors derived from the selected row:
//    minOut floor  = quoted exit output * 0.98 (nonzero);
//    minProfit floor = strict exit-depth net (netAtQuotedSize) when available, else
//                      row.netUsdc - row.gasBoundUsdc; must be > 0.
//    Both are expressed in the row's debt-token raw unit; the calldata labels that
//    unit explicitly and never fabricates a converted value.
function gateEconomics(row, depth) {
  if (!row || typeof row !== "object") return { ok: false, detail: "economics-route-row-unavailable" };
  const d = depth || pickExitDepth(row, new Map());
  if (!d || d.outQuoted === null || d.outQuoted <= 0n) return { ok: false, detail: "economics-quoted-exit-out-missing-or-nonpositive" };
  const quotedOut = d.outQuoted;
  const minOutFloorRaw = (quotedOut * MIN_OUT_HAIRCUT_BPS) / 100n;
  if (minOutFloorRaw <= 0n) return { ok: false, detail: "economics-minOut-floor-nonpositive" };
  const netExec = d.netAtQuotedSize !== null ? d.netAtQuotedSize : (toBig(row.netUsdc) ?? null) - (toBig(row.gasBoundUsdc) ?? 0n);
  if (netExec === null) return { ok: false, detail: "economics-net-missing", minOutFloorRaw };
  if (netExec <= 0n) return { ok: false, detail: `economics-minProfit-floor-nonpositive(${netExec})`, minOutFloorRaw };
  return {
    ok: true,
    detail: `minOutFloorRaw=${minOutFloorRaw} minProfitFloorRaw=${netExec} (quotedOut=${quotedOut}*0.98; net=${d.netAtQuotedSize !== null ? "exitDepth.netAtQuotedSize" : "netUsdc-gasBound"})`,
    floors: { minOutFloorRaw, minProfitFloorRaw: netExec, quotedOut, netExec },
  };
}

const GATE_DEFS = [
  { id: "0", name: "executor deployed (non-placeholder)", fn: gateDeployed },
  { id: "a", name: "batch approved/unexpired/account/triggerGated", fn: gateBatch },
  { id: "b", name: "fresh trigger surface (optional watcher + economics routePositive exit-depth-sized <=10m, highest net)", fn: gateFreshTrigger },
  { id: "c", name: "fork rehearsal real-candidate proof (TEMPORARY SAFE BLOCK: mock/generic PASS refused, no live success path)", fn: gateRehearsal },
  { id: "d", name: "economics floors (minOut=quoted*0.98, minProfit=strict exit-depth net) nonzero", fn: gateEconomics },
];

// Builders kept separate from I/O so the no-feasible-row diagnostic is testable
// offline and its bounded probe log is always carried honestly.
function refusalPayload(mode, gates, firstFailure, executor) {
  return {
    ok: false,
    reason: "execution-needs-live-trigger-state",
    stage: "PRECONDITION_GATES",
    mode,
    executor,
    firstFailure,
    keyRead: false,
    networkWrite: false,
    gates,
  };
}

function buildNoFeasibleRowPayload(probeLog, gates, meta) {
  const m = meta || {};
  const list = Array.isArray(probeLog) ? probeLog : [];
  const lastReason = list.length ? (list[list.length - 1].skip || "none-probed") : "no-eligible-rows";
  return {
    ok: false,
    reason: "no-feasible-row:" + sanitize(lastReason).slice(0, 100),
    stage: "NO_FEASIBLE_ROW",
    mode: m.mode || null,
    executor: m.executor || null,
    keyRead: m.keyRead === true,
    networkWrite: false,
    gates: Array.isArray(gates) ? gates.map(g => ({ id: g.id, status: g.status, detail: g.detail })) : [],
    rowSelection: list,
  };
}

// runTrigger: the real CLI entrypoint. All side-effecting dependencies are
// injectable so the offline suite can drive the gate order (including the
// gate-c execution block) without reading keys, providers, or live artifacts.
async function runTrigger(deps) {
  const d = deps || {};
  const argv = Array.isArray(d.argv) ? d.argv : process.argv.slice(2);
  const execute = argv.includes("--execute");
  const mode = execute ? "EXECUTE" : "DRY_RUN";
  const executor = d.executor || EXECUTOR;
  const readJson = d.readJson || tryReadJson;
  const depthRowsFn = d.loadExitDepthRows || loadExitDepthRows;
  const rpc = d.rpcOn || rpcOn;
  const qualifyFn = d.qualify || qualify;
  const loadKey = d.loadPrivateKey || loadPrivateKey;
  const log = d.log || ((payload) => console.log(JSON.stringify(payload, null, 2)));
  const exit = d.exit || ((code) => process.exit(code));

  // ---- step 2: evaluate every gate in order; stop at the first failure ----
  const gates = [];
  const ctx = {};
  for (let i = 0; i < GATE_DEFS.length; i++) {
    const def = GATE_DEFS[i];
    let result;
    if (def.id === "0") result = gateDeployed(executor);
    else if (def.id === "d") result = gateEconomics(ctx.triggerRow, ctx.exitDepth);
    else result = def.fn({ readJson, depthRows: depthRowsFn, executor });
    const ok = result.ok === true;
    gates.push({ order: def.id, id: def.id, name: def.name, ok, status: ok ? "pass" : "fail", detail: result.detail });
    if (!ok) {
      for (let j = i + 1; j < GATE_DEFS.length; j++) {
        gates.push({ order: GATE_DEFS[j].id, id: GATE_DEFS[j].id, name: GATE_DEFS[j].name, ok: null, status: "skipped", detail: "not evaluated: earlier gate failed" });
      }
      log(refusalPayload(mode, gates, def.id, executor));
      return exit(1);
    }
    if (def.id === "a") ctx.batch = result.batch;
    if (def.id === "b") { ctx.triggerRow = result.row; ctx.exitDepth = result.depth; ctx.candidates = result.candidates; ctx.economics = result.economics; }
    if (def.id === "d") ctx.floors = result.floors;
  }

  // ---- step 3: only after every gate passed ----
  const batch = ctx.batch;
  const floors = ctx.floors;
  let row = null; // selected by the bounded feasibility loop below

  let wallet = null;
  let keyRead = false;
  if (execute) {
    const key = loadKey();
    keyRead = true;
    wallet = new Wallet(key);
    if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) return fail("key-account-mismatch");
  }
  const from = wallet ? wallet.address : getAddress(MAIN_ACCOUNT);

  const provider = await qualifyFn();
  const [nonce, chainId, latest] = await Promise.all([
    rpc(provider, "eth_getTransactionCount", [from, "pending"]),
    rpc(provider, "eth_chainId", []),
    rpc(provider, "eth_getBlockByNumber", ["latest", false]),
  ]);

  // ---- bounded candidate feasibility selection (fail-closed per row; honest probe log) ----
  // The shared eligibility helper runs BEFORE sort/truncate, so ineligible top-net
  // rows (wrong chain, unsized, non-executable estimate, foreign exit pool) can never
  // consume the MAX_ROW_PROBES budget or starve an eligible row. Every probeLog entry
  // carries the full vault + chainId; reasons are fixed/sanitized (no endpoint/error raw).
  const depthRows = depthRowsFn();
  const econRows = Array.isArray(ctx.economics?.rows) ? ctx.economics.rows : [];
  const selection = selectProbeRows(econRows, depthRows);
  const probeLog = [...selection.rejected];

  let winnerDebt = null, winnerMinOut = null, winnerMinProfit = null, winnerDepth = null;
  for (const cand of selection.eligible) {
    const depth = cand.depth;
    const entry = { vault: lc(cand.row.vault), chainId: parseChainId(cand.row.chainId) };
    const floorsC = gateEconomics(cand.row, depth);
    if (!floorsC.ok) {
      probeLog.push({ ...entry, skip: "floors:" + floorsC.detail });
      continue;
    }
    const debtAmt = toBig(cand.row.debtValued) ?? toBig(cand.row.debtValueRaw) ?? toBig(depth.debtValuedRaw) ?? toBig(depth.debtValueRaw);
    if (debtAmt === null || debtAmt <= 0n) {
      probeLog.push({ ...entry, skip: "debtAmt-nonpositive" });
      continue;
    }
    const balRaw = await readBalancerBalance(provider, cand.row.debtToken, rpc).catch(() => null);
    if (balRaw === null) {
      probeLog.push({ ...entry, skip: "flash-balance-unreadable" });
      continue;
    }
    if (balRaw < debtAmt) {
      probeLog.push({ ...entry, skip: "flash-source-insufficient", bal: balRaw.toString(), requested: debtAmt.toString() });
      continue;
    }

    // live liveness: the vault's own liquidate-preceded state (simulateLiquidate
    // reverts with FluidLiquidateResult(col,debt)); a paid/zero row is already
    // eaten, an unreadable probe refuses instead of firing.
    const live = await readVaultLiquidatable(provider, cand.row.vault, rpc).catch(() => null);
    if (live === null) {
      probeLog.push({ ...entry, skip: "liveness-unreadable" });
      continue;
    }
    if (!live.liquidatable) {
      probeLog.push({ ...entry, skip: "row-not-liquidatable", reason: live.reason });
      continue;
    }
    if (live.debtLiquidated !== null && live.debtLiquidated < debtAmt) {
      probeLog.push({ ...entry, skip: "liveness-shrunk", liveDebt: live.debtLiquidated.toString(), rowDebt: debtAmt.toString() });
      continue;
    }

    winnerDebt = debtAmt;
    winnerMinOut = floorsC.floors.minOutFloorRaw;
    winnerMinProfit = floorsC.floors.minProfitFloorRaw;
    winnerDepth = depth;
    row = cand.row;
    break;
  }
  if (!row) {
    log(buildNoFeasibleRowPayload(probeLog, gates, { mode, executor, keyRead }));
    return exit(1);
  }

  const vaultType = /T4/i.test(String(row.type || "")) ? 1 : 0;
  const exitIsToken0 = lc(row.colToken0) === lc(row.debtToken);
  const colPerUnitDebt = toBig(row.colPerDebtLiquidateRaw);
  const colAmtPerUnitShares = toBig(row.colAmtPerUnitShares) ?? 10n ** 18n;
  if (colPerUnitDebt === null || colPerUnitDebt <= 0n) return fail("colPerUnitDebt-nonpositive");
  if (colAmtPerUnitShares <= 0n) return fail("colAmtPerUnitShares-nonpositive");
  if (winnerDebt === null || winnerMinOut === null || winnerMinProfit === null) return fail("winner-live-values-missing");

  // T2 single-token exit: debtAmt == total debt; token0/token1 debt splits are 0.
  // T4 (future): the requested debt side is the one whose debt token matches debtToken.
  const token0DebtAmt = vaultType === 1 && lc(row.debtToken) === lc(row.debtToken0) ? winnerDebt : 0n;
  const token1DebtAmt = vaultType === 1 && lc(row.debtToken) === lc(row.debtToken1) ? winnerDebt : 0n;
  const debtAmt = winnerDebt; // T2: whole debt; T4: the single requested debt side equals the flash amount
  const debtSharesMin = vaultType === 1 ? 1n : 0n;
  const exitToken = getAddress(row.debtToken);
  const params = [
    getAddress(row.vault), vaultType, exitToken, debtAmt,
    token0DebtAmt, token1DebtAmt, debtSharesMin, colPerUnitDebt,
    exitIsToken0, exitToken, colAmtPerUnitShares, false,
    winnerMinOut, winnerMinProfit, EXECUTOR_PLACEHOLDER, "0x",
  ];
  if (row.vaultType && Number(row.vaultType) !== vaultType) return fail("vaultType-mismatch");

  const data = EXEC_IFACE.encodeFunctionData("execute", [params]);

  let gasLimitEst = null;
  try {
    gasLimitEst = await rpc(provider, "eth_estimateGas", [{ from, to: EXECUTOR, data }]);
  } catch (err) {
    return fail("estimate-failed:" + sanitize(err && err.message ? err.message : String(err)).slice(0, 80));
  }

  let gasLimit = null, maxFeePerGas = null, estTotal = null;
  if (gasLimitEst !== null) {
    gasLimit = BigInt(gasLimitEst);
    const batchMaxGasLimit = BigInt(batch.caps?.maxGasLimitPerTransaction ?? 0);
    if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) return fail("gas-limit-exceeds-batch-cap");
    const baseFeeWei = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : BigInt(7);
    const tipWei = BigInt(1_000_000_000);
    const margin = (baseFeeWei * 2n) + (tipWei * 12n) / 10n + 2n;
    const batchMaxSpend = BigInt(batch.caps?.maxNativeSpendPerTransactionWei ?? 0);
    const capWeiPerGas = batchMaxSpend > 0n ? batchMaxSpend / gasLimit : 0n;
    maxFeePerGas = margin;
    if (capWeiPerGas > 0n && margin > capWeiPerGas) maxFeePerGas = capWeiPerGas;
    if (maxFeePerGas <= 0n) return fail("zero-fee");
    estTotal = gasLimit * maxFeePerGas;
    if (batchMaxSpend > 0n && estTotal > batchMaxSpend) return fail("spend-exceeds-batch-cap");
  }

  const tx = gasLimitEst !== null ? {
    type: 2,
    chainId: Number(BigInt(chainId)),
    nonce: Number(BigInt(nonce)),
    to: EXECUTOR,
    data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: BigInt(1_000_000_000),
  } : null;

  const estimate = {
    gasLimit: gasLimit !== null ? gasLimit.toString() : null,
    maxFeePerGas: maxFeePerGas !== null ? maxFeePerGas.toString() : null,
    maxPriorityFeePerGas: gasLimitEst !== null ? BigInt(1_000_000_000).toString() : null,
    estimatedMaxFeeWei: estTotal !== null ? estTotal.toString() : null,
    batchCapWei: BigInt(batch.caps?.maxNativeSpendPerTransactionWei ?? 0) > 0n ? batch.caps.maxNativeSpendPerTransactionWei : null,
    summary: `gas<=${gasLimit} maxFee<=${maxFeePerGas}wei estimatedMaxFeeWei=${estTotal}`,
  };
  const calldata = {
    vault: getAddress(row.vault),
    vaultType,
    debtToken: exitToken,
    debtAmt: debtAmt.toString(),
    token0DebtAmt: token0DebtAmt.toString(),
    token1DebtAmt: token1DebtAmt.toString(),
    debtSharesMin: debtSharesMin.toString(),
    colPerUnitDebt: colPerUnitDebt.toString(),
    exitIsToken0,
    exitToken,
    colAmtPerUnitShares: colAmtPerUnitShares.toString(),
    absorb: false,
    minOut: winnerMinOut.toString(),
    minProfitWei: winnerMinProfit.toString(),
    router: EXECUTOR_PLACEHOLDER,
    routerSwapData: "0x",
    floorsQuoteUnit: "debt-token-raw (exitDepth.outQuoted / netAtQuotedSize or netUsdc-gasBound; not converted, not fabricated)",
    exitDepthSource: winnerDepth ? winnerDepth.source : null,
  };

  if (!execute) {
    log({
      ok: true,
      stage: "DRY_RUN_ESTIMATE",
      mode,
      executor,
      keyRead: false,
      networkWrite: false,
      gates: gates.map(g => ({ id: g.id, status: g.status, detail: g.detail })),
      rowSelection: probeLog,
      nonce: tx ? tx.nonce : null,
      chainId: Number(BigInt(chainId)),
      calldata,
      estimate,
    });
    return;
  }

  const signed = await wallet.signTransaction(tx);
  const txHash = await rpc(provider, "eth_sendRawTransaction", [signed]);
  log({ ok: true, stage: "SENT", txHash });

  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    try {
      receipt = await rpc(provider, "eth_getTransactionReceipt", [txHash]);
      if (receipt && receipt.status !== undefined) break;
    } catch (_) { continue; }
  }
  if (!receipt || receipt.status === null) {
    log({ ok: false, reason: "receipt-timeout", txHash });
    process.exitCode = 2;
    return;
  }

  const out = {
    schema: "fluid-t2t4-liquidation-execution/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/execute-fluid-t2t4-trigger.js",
    batchId: batch.batchId,
    executor,
    txHash,
    status: receipt.status,
    ok: receipt.status === "0x1" || receipt.status === "0x01",
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice || 0).toString(),
    netDeltas: null,
    netDeltasNote: "not fabricated; net debt-token/profit deltas require post-execution balance reads and are deliberately not estimated here",
    calldata,
    rowSelection: probeLog,
    gates: gates.map(g => ({ id: g.id, status: g.status })),
    readonly: false,
    signedActionJustified: true,
  };
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, `execution-${Date.now()}.json`), JSON.stringify(out, null, 2) + "\n", "utf8");
  log(out);
}

if (require.main === module) {
  runTrigger().catch((err) => {
    console.error(sanitize(err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}

module.exports = {
  GATE_DEFS,
  gateDeployed,
  gateBatch,
  gateFreshTrigger,
  gateRehearsal,
  gateEconomics,
  normalizeExitDepth,
  pickExitDepth,
  parseChainId,
  isEligibleRow,
  selectProbeRows,
  buildNoFeasibleRowPayload,
  refusalPayload,
  runTrigger,
  MAX_ROW_PROBES,
  PATHS: { BUNDLE, WATCH_STATUS, ECONOMICS, EXIT_DEPTH, REHEARSAL, OUTDIR },
};
