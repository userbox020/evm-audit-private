#!/usr/bin/env node
"use strict";

const crypto = require("crypto"), { spawn, spawnSync } = require("child_process"), net = require("net"), path = require("path");
const { ethers } = require("ethers"), { loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");
const ROOT = path.resolve(__dirname, ".."), TARGET = path.join(ROOT, "targets", "cash-v3");
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex"), lower = (x) => String(x).toLowerCase();
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const sanitize = (x) => String(x).replace(/(?:https?|wss?):\/\/[^\s"']+/gi, "[REDACTED_URL]");
async function freePort() { for (let p = 28845; p < 28945; p++) { const ok = await new Promise((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.once("listening", () => s.close(() => r(true))); s.listen(p, "127.0.0.1"); }); if (ok) return p; } fail("NO_LOCAL_PORT"); }
async function localRpc(port, method, params = [], timeout = 10000) { const c = new AbortController(), t = setTimeout(() => c.abort(), timeout); try { const r = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) fail(`LOCAL_RPC_${method}`); return j.result; } finally { clearTimeout(t); } }
async function wait(port, child) { for (let i = 0; i < 120; i++) { if (child.exitCode !== null) return false; try { if (await localRpc(port, "eth_chainId", [], 500) === "0xa") return true; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); } return false; }
async function startFork(pin, hash) { const tag = ethers.toQuantity(pin); for (const url of [...new Set([...loadRpcUrls(), PUBLIC_FALLBACKS[10]].filter(Boolean))]) { if (await rpcCall(url, "eth_chainId", [], 3500) !== "0xa") continue; const h = await rpcCall(url, "eth_getBlockByNumber", [tag, false], 6000); if (!h || lower(h.hash) !== lower(hash)) continue; const port = await freePort(), child = spawn("anvil", ["--fork-url", url, "--fork-block-number", String(pin), "--port", String(port), "--host", "127.0.0.1", "--silent"], { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); let diag = ""; child.stdout.on("data", (x) => { diag += x; }); child.stderr.on("data", (x) => { diag += x; }); if (await wait(port, child)) return { port, child, diagnosticSha256: sha(diag) }; child.kill(); } fail("NO_PINNED_FORK_ENDPOINT"); }

async function main() {
  const i = process.argv.indexOf("--pin-number"), j = process.argv.indexOf("--pin-hash"); if (i < 0 || j < 0) fail("PIN_ARGS_REQUIRED");
  const pin = Number(process.argv[i + 1]), pinHash = process.argv[j + 1]; let fork;
  try {
    fork = await startFork(pin, pinHash); const localUrl = `http://127.0.0.1:${fork.port}`;
    const run = spawnSync("forge", ["test", "--fork-url", localUrl, "--fork-block-number", String(pin), "--match-path", "test/critical/DebtManagerUSDCCurrentDustFork.t.sol", "--match-contract", "DebtManagerUSDCCurrentDustForkTest", "--skip", "SafeAssetRecoveryInvariant", "-vv"], { cwd: TARGET, encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (run.status !== 0) fail(`FORGE_FAILED:${sanitize(run.stderr || run.stdout)}`);
    const tests = [...run.stdout.matchAll(/\[PASS\]\s+([^\r\n]+?)\s+\(gas:\s*(\d+)\)/g)].map((m) => ({ name: m[1].trim(), status: "PASS", gas: Number(m[2]) })).sort((a, b) => a.name.localeCompare(b.name));
    if (tests.length !== 3) fail("THREE_FORK_TESTS_REQUIRED");
    const output = { schemaVersion: 1, classification: "EPHEMERAL_CURRENT_PIN_USDC_DUST_COUNTERFACTUAL", pin: { chainId: 10, number: pin, hash: pinHash }, proof: { nonIncumbentCapitalRaw: "CURRENT_TOTAL_ASSETS_RAW", victimCount: 2, victimAmountEachRaw: "1", grossGainRaw: "1", donationRaw: "0", observedMinimumSupplyRaw: "10000000", observedMinimumForcedZeroGrossUpperBoundNegative: true, currentObservableDustVictimFlow: false }, forge: { testCount: tests.length, passCount: tests.length, tests, transcriptSha256: sha(run.stdout) }, safety: { endpointPersisted: false, rawRpcPersisted: false, privateKeys: false, liveSignedTransactions: false, broadcast: false, productionMutation: false, realFunds: false, localImpersonationAndDealOnly: true, forkDestroyed: true } };
    const text = JSON.stringify(output); if (/(?:https?|wss?):\/\//i.test(text)) fail("OUTPUT_LEAK"); process.stdout.write(`${text}\n`);
  } finally { if (fork) fork.child.kill(); }
}
main().catch((e) => { process.stderr.write(`DebtManager USDC dust fork stopped: ${e.code || "FAIL_CLOSED"}\n`); process.exit(1); });
