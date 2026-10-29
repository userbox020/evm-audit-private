#!/usr/bin/env node
"use strict";
/**
 * run-config-delta-cycle3.js
 *
 * Cycle-3 coverage-restoration driver for the config-delta saturation test.
 *
 *  1. capability-qualifies a bounded endpoint pool per chain (archive state +
 *     full-window deep eth_getLogs) via tools/qualify-config-delta-rpcs-v1.js;
 *  2. writes the sanitized qualification artifact;
 *  3. spawns tools/scan-config-deltas.js with the selected endpoints supplied
 *     process-only via the child ENVIRONMENT (never argv), in strict-endpoint
 *     mode, writing reports/raw/fast/config-deltas-cycle3-20260915.json.
 *
 * No endpoint value/URL/host/credential is printed, logged, persisted or placed
 * on a child command line. Only capability outcomes and counts are emitted.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { qualify, OUT_FILE: QUAL_FILE } = require("./qualify-config-delta-rpcs-v1.js");

const WORKSPACE = path.resolve(__dirname, "..");
const CHAIN_IDS = [1, 8453, 42161, 56];
const CYCLE3_OUT = "config-deltas-cycle3-20260915.json";

async function main() {
  const { urlMap, artifact, selection } = await qualify({ chainIds: CHAIN_IDS });

  fs.mkdirSync(path.dirname(QUAL_FILE), { recursive: true });
  fs.writeFileSync(QUAL_FILE, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  const qualifiedChains = CHAIN_IDS.filter((cid) => artifact.perChain[cid] && artifact.perChain[cid].capability);
  const unavailableChains = CHAIN_IDS.filter((cid) => !qualifiedChains.includes(cid));

  console.log("qualification=" + JSON.stringify({
    qualifiedChains,
    unavailableChains,
    perChain: Object.fromEntries(CHAIN_IDS.map((cid) => [cid, {
      capability: artifact.perChain[cid]?.capability || false,
      archiveReadyCount: artifact.perChain[cid]?.archiveReadyCount ?? null,
      logsReadyCount: artifact.perChain[cid]?.logsReadyCount ?? null,
      independentFamiliesSelected: artifact.perChain[cid]?.independentFamiliesSelected ?? 0,
    }])),
    selection,
  }));

  if (qualifiedChains.length === 0) {
    console.error("cycle3 aborted: no chain capability-qualified");
    process.exitCode = 1;
    return;
  }

  const env = {
    ...process.env,
    CONFIG_DELTA_RPC_JSON: JSON.stringify(urlMap),
    CONFIG_DELTA_STRICT_ENDPOINTS: "1",
    CONFIG_DELTA_OUT: CYCLE3_OUT,
    CONFIG_DELTA_PROFILE: "cycle3",
  };

  const child = spawn(process.execPath, ["tools/scan-config-deltas.js"], {
    cwd: WORKSPACE,
    env,
    stdio: "inherit",
  });
  child.on("exit", (code) => { process.exitCode = code === 0 ? 0 : 1; });
  child.on("error", () => { console.error("cycle3 scanner spawn failed"); process.exitCode = 1; });
}

main().catch((error) => {
  console.error("run-config-delta-cycle3 failed: " + String(error && error.message ? error.message : "error").replace(/https?:\/\/\S+/g, "[redacted]"));
  process.exitCode = 1;
});
