#!/usr/bin/env node
"use strict";

const SCHEMA = "morpho-pt-27aug2026-post-expiry-r4-pre-go-diagnostic/v2";
const KEYS = Object.freeze(Array.from({ length: 10 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`));
const ALLOWED = Object.freeze({
  P01: ["P01_PASS", "P01_FAIL"], P02: ["P02_PASS", "P02_FAIL"], P03: ["P03_PASS_SYNTHETIC_ONLY", "P03_FAIL"], P04: ["P04_PASS_SYNTHETIC_ONLY", "P04_FAIL"],
  P05: ["P05_PASS_CURRENT_NONCE_UNAVAILABLE", "P05_PASS_EXPIRED_NONCE_UNAVAILABLE", "P05_ACTIVE_PERMIT_ABSENT", "P05_FAIL"], P06: ["P06_PASS", "P06_FAIL"], P07: ["P07_PASS_CLEAN", "P07_FAIL"],
  P08: ["P08_PASS_SYNTHETIC_ONLY", "P08_FAIL"], P09: ["P09_PASS_SYNTHETIC_ONLY", "P09_FAIL"], P10: ["P10_PASS", "P10_FAIL"],
});
const SAFETY_KEYS = Object.freeze([
  "captureExecutions", "issuerExecutions", "conductorExecutions", "productionNodeDiagnosticExecutions", "productionPermitReads",
  "inventoryReads", "networkRequests", "nonceMutations", "productionMutations", "syntheticMutationOperations", "syntheticCleanupOperations",
  "wslChildExecutions", "powershellChildExecutions", "containedChildExecutions", "childTreeCleanupConfirmations",
]);
const FIXED_ZERO = Object.freeze(["captureExecutions", "issuerExecutions", "conductorExecutions", "inventoryReads", "networkRequests", "nonceMutations", "productionMutations"]);
const MAX_STDIN_BYTES = 8192;
function canonical(value) { if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function validate(value) {
  if (!exact(value, ["schema", "overall", "phases", "safety"]) || value.schema !== SCHEMA || !exact(value.phases, KEYS) || !exact(value.safety, SAFETY_KEYS)) throw new Error("SCHEMA");
  for (const key of KEYS) if (!ALLOWED[key].includes(value.phases[key])) throw new Error("PHASE");
  for (const key of SAFETY_KEYS) if (!Number.isSafeInteger(value.safety[key]) || value.safety[key] < 0) throw new Error("SAFETY_TYPE");
  for (const key of FIXED_ZERO) if (value.safety[key] !== 0) throw new Error("SAFETY_ZERO");
  const safety = value.safety;
  if (safety.productionNodeDiagnosticExecutions !== safety.wslChildExecutions || safety.containedChildExecutions !== safety.wslChildExecutions || safety.powershellChildExecutions !== safety.wslChildExecutions + (safety.powershellChildExecutions > 0 ? 1 : 0) || safety.childTreeCleanupConfirmations !== safety.containedChildExecutions) throw new Error("CHILD_COUNTS");
  if (safety.productionPermitReads > 1 || (value.phases.P05.includes("PASS_") && safety.productionPermitReads !== 1) || (value.phases.P05 === "P05_ACTIVE_PERMIT_ABSENT" && safety.productionPermitReads !== 0)) throw new Error("PERMIT_READS");
  if (value.phases.P08 === "P08_PASS_SYNTHETIC_ONLY" && value.phases.P09 === "P09_PASS_SYNTHETIC_ONLY" && (safety.syntheticMutationOperations !== 7 || safety.syntheticCleanupOperations !== 2)) throw new Error("SYNTHETIC_COUNTS");
  if (safety.syntheticMutationOperations > 7 || safety.syntheticCleanupOperations > 2) throw new Error("SYNTHETIC_COUNTS");
  const failed = KEYS.some((key) => value.phases[key].endsWith("_FAIL")), derived = failed ? "FAIL" : value.phases.P05 === "P05_ACTIVE_PERMIT_ABSENT" ? "BLOCKED_ACTIVE_PERMIT_ABSENT" : value.phases.P05.includes("EXPIRED") ? "BLOCKED_EXPIRED" : "PASS_LIMITED";
  if (value.overall !== derived) throw new Error("OVERALL");
  const text = canonical(value); if (/[a-z]:\\|\/(?:home|mnt|tmp)\/|(?:https?|wss):\/\/|\b[0-9a-f]{64}\b|permitId|approvalNonce|authCommitment|productionCaptureIdentity|rpc_endpoints|endpointData/iu.test(text)) throw new Error("LEAK");
  return value;
}
if (require.main === module) {
  const chunks = []; let size = 0, failed = false;
  process.stdin.on("data", (chunk) => { if (failed) return; size += chunk.length; if (size > MAX_STDIN_BYTES) { failed = true; chunks.length = 0; process.exitCode = 1; process.stdin.destroy(); return; } chunks.push(chunk); });
  process.stdin.on("end", () => { if (failed) return; try { const value = validate(JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); process.stdout.write(`${canonical(value)}\n`); } catch (_) { process.exitCode = 1; } });
  process.stdin.on("error", () => { failed = true; chunks.length = 0; process.exitCode = 1; });
}
module.exports = Object.freeze({ SCHEMA, KEYS, ALLOWED, SAFETY_KEYS, FIXED_ZERO, MAX_STDIN_BYTES, canonical, validate });
