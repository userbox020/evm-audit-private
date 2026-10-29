#!/usr/bin/env node
"use strict";
// target-screen.js — Stage-1 screen driver per the framework
// (reports/profitable-exploit-analysis-framework-20261012.md).
//
// Wraps existing read-only producers (never re-implements protocol logic),
// runs one fresh-pin screen, and writes an honest, minimal screen.json:
//   reports/raw/fast/target-screen/<chain>-<target>-<utcstamp>/screen.json
//
// Scope guards: read-only; no signing; no broadcasting; no coverage-row writes
// (the harness FEEDS candidates upward, it does not own producer artifacts).
// usage:
//   node tools/target-screen.js --target morpho-blue-l-base
//   node tools/target-screen.js --target morpho-blue-l-ethereum
//   node tools/target-screen.js --target cross-dex-arbitrage

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// The registry binds each target to its EXISTING producer CLI + artifact key.
const SCANNER_REGISTRY = Object.freeze({
  "morpho-blue-l-base": Object.freeze({
    chainId: 8453,
    scanner: "tools/scan-morpho-blue-l.js",
    args: ["--chain", "8453"],
    artifact: "reports/raw/fast/morpho-blue-liquidatable-base.json",
    summary: ["pin", "valuation", "totals", "coverage"],
  }),
  "morpho-blue-l-ethereum": Object.freeze({
    chainId: 1,
    scanner: "tools/scan-morpho-blue-l.js",
    args: ["--chain", "1"],
    artifact: "reports/raw/fast/morpho-blue-liquidatable.json",
    summary: ["pin", "valuation", "totals", "coverage"],
  }),
  "cross-dex-arbitrage": Object.freeze({
    chainId: null, // fixed routes: Ethereum FRAX/USDC + Base USDC/USDT
    scanner: "tools/scan-cross-dex-arbitrage.js",
    args: [],
    artifact: "reports/raw/fast/cross-dex-arbitrage.json",
    summary: ["pin", "rows", "grossPositiveRows", "economics"],
  }),
  "aave-v3-l-ethereum": Object.freeze({
    chainId: 1,
    scanner: "tools/scan-aave-v3-l.js",
    args: ["--chain", "ethereum"],
    artifact: "reports/raw/fast/aave-v3-liquidatable.json",
    summary: ["pin", "valuation", "totals", "coverage"],
  }),
  "aave-v3-l-base": Object.freeze({
    chainId: 8453,
    scanner: "tools/scan-aave-v3-l.js",
    args: ["--chain", "base"],
    artifact: "reports/raw/fast/aave-v3-liquidatable-base.json",
    summary: ["pin", "valuation", "totals", "coverage"],
  }),
});

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

(async () => {
  const argv = process.argv.slice(2);
  const target = arg(argv, "--target");
  if (!target || !SCANNER_REGISTRY[target]) {
    console.log(JSON.stringify({ status: "USAGE", known: Object.keys(SCANNER_REGISTRY), transactions: 0 }));
    process.exitCode = 1;
    return;
  }
  const spec = SCANNER_REGISTRY[target];
  const outDir = path.join(ROOT, "reports", "raw", "fast", "target-screen", `${spec.chainId ?? "multi"}-${target}-${safeStamp()}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(JSON.stringify({ status: "SCREEN_START", target, scanner: spec.scanner, transactions: 0 }));

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, spec.scanner), ...spec.args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 30 * 60_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(error) }); });
  });

  let artifact = null;
  try { artifact = JSON.parse(fs.readFileSync(path.join(ROOT, spec.artifact), "utf8")); } catch (_) {}

  const summary = {};
  for (const field of spec.summary) summary[field] = artifact ? artifact[field] ?? null : null;

  const screen = {
    schema: "target-screen/v1",
    generatedAt: new Date().toISOString(),
    target,
    scanner: spec.scanner,
    scannerExitCode: result.code,
    scannerStderrTail: result.stderr.slice(-300),
    artifact: spec.artifact,
    artifactPresent: artifact !== null,
    artifactSummary: summary,
    chainId: spec.chainId,
    readOnly: true,
    transactions: 0,
    stagesReached: 1,
    nextStage: "Stage 2 WIRE-ESTABLISH (named bounded batch) only if the screen emits a gross-positive signal",
  };
  const file = path.join(outDir, "screen.json");
  fs.writeFileSync(file, `${JSON.stringify(screen, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: artifact ? "SCREEN_DONE" : "SCREEN_DONE_NO_ARTIFACT", exitCode: result.code, screen: path.relative(ROOT, file), transactions: 0 }));
})().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: "HARNESS_FAILURE", reason: String(error && error.message || error).slice(0, 120), transactions: 0 })}\n`);
  process.exitCode = 1;
});
