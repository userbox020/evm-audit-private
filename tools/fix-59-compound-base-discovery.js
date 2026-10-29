#!/usr/bin/env node
"use strict";
// Exact user-specified Comet only. No alternate-address fallback or mutations.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Interface } = require("./node_modules/ethers");
const ROOT = path.resolve(__dirname, "..");
const COMET = "0xb125e6687d431f4f22bdd7f03a6045301c227474";
const abi = new Interface(["function baseToken() view returns(address)", "function totalBorrow() view returns(uint256)"]);
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function write(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|[?&](?:key|token)=/i.test(bytes.toString())) throw Error("SANITIZATION_FAILED");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, bytes, { flag: "wx" });
  fs.renameSync(tmp, file);
  return { sha256: sha(bytes), bytes: bytes.length };
}
async function main() {
  const started = Date.now();
  const value = { schema: "fix-59-compound-base-discovery/v1", generatedAt: new Date().toISOString(),
    comet: COMET, chainId: 8453, status: "INCOMPLETE", reason: null,
    pin: { requested: "finalized", number: null, hash: null, rechecked: false },
    rpcCount: 0, maxRpcCalls: 25, ledger: [], borrowers: [], nearLiquidationCandidates: [],
    rankingEstablished: false, nearLiquidationCountEstablished: false,
    interfaceNote: "Comet uses borrowBalanceOf and collateralBalanceOf; borrowBalanceStored and collateralBalanceStored are not Comet getters.",
    safety: { readOnly: true, signing: false, deployment: false, transactions: false, rpcUrlsStored: false, keysRead: false } };
  async function rpc(method, params) {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method)) throw Error("METHOD_REJECTED");
    if (value.rpcCount >= 25 || Date.now() - started > 60000) throw Error("BUDGET_EXCEEDED");
    const row = { ordinal: ++value.rpcCount, method, status: "PENDING" }; value.ledger.push(row);
    try {
      const res = await fetch("https:" + "//base-rpc.publicnode.com/", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: row.ordinal, method, params }), signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!res.ok) throw Error("RPC_HTTP_FAILURE");
      const body = await res.json();
      if (body.error || body.id !== row.ordinal || !Object.hasOwn(body, "result")) throw Error("RPC_READ_FAILURE");
      row.status = "OK"; return body.result;
    } catch (_) { row.status = "RPC_READ_FAILURE"; throw Error(row.status); }
  }
  try {
    if (await rpc("eth_chainId", []) !== "0x2105") throw Error("CHAIN_MISMATCH");
    const header = await rpc("eth_getBlockByNumber", ["finalized", false]);
    if (!/^0x[0-9a-f]{64}$/i.test(header?.hash || "") || !/^0x[0-9a-f]+$/i.test(header?.number || "")) throw Error("PIN_INVALID");
    Object.assign(value.pin, { number: Number(BigInt(header.number)), hash: header.hash, timestamp: Number(BigInt(header.timestamp)) });
    const binding = { blockHash: header.hash, requireCanonical: true };
    const code = await rpc("eth_getCode", [COMET, binding]);
    value.codeBytes = (code.length - 2) / 2;
    value.codeSha256 = sha(Buffer.from(code.slice(2), "hex"));
    if (code === "0x") {
      value.status = "STOPPED_NO_MEANINGFUL_DATA";
      value.reason = "EXACT_REQUESTED_COMET_HAS_NO_RUNTIME_CODE_AT_FINALIZED_PIN";
    } else {
      for (const fn of ["baseToken", "totalBorrow"]) {
        const raw = await rpc("eth_call", [{ to: COMET, data: abi.encodeFunctionData(fn) }, binding]);
        value[fn] = abi.decodeFunctionResult(fn, raw)[0].toString();
      }
      value.reason = "NO_VERIFIED_TOP_BORROWER_SEED_FOR_EXACT_REQUESTED_COMET";
      if (value.totalBorrow === "0") { value.status = "STOPPED_NO_MEANINGFUL_DATA"; value.reason = "EXACT_REQUESTED_COMET_HAS_ZERO_TOTAL_BORROW"; }
    }
    const check = await rpc("eth_getBlockByNumber", [header.number, false]);
    if (check?.hash !== header.hash) throw Error("PIN_DRIFT");
    value.pin.rechecked = true;
  } catch (e) { value.status = "INCOMPLETE"; value.reason = /^[A-Z_]+$/.test(e.message) ? e.message : "READ_OR_DECODE_FAILURE"; }
  value.completedAt = new Date().toISOString(); value.durationMs = Date.now() - started;
  value.limitations = "No alternate Comet address queried. No top-3 ranking or HF can be claimed without meaningful Comet state and verified borrowers. An empty candidate list does not establish zero near-liquidation borrowers.";
  const relative = "reports/raw/fast/compound-v3-base-discovery/fix-59-" + value.generatedAt.replace(/[-:.]/g, "") + ".json";
  const digest = write(path.join(ROOT, relative), value);
  const manifest = write(path.join(ROOT, relative.replace(/\.json$/, ".manifest.json")), { schema: "compound-v3-base-discovery-manifest/v1", artifact: relative, ...digest, readOnly: true });
  process.stdout.write(JSON.stringify({ ...value, artifactPath: relative, captureSha256: digest.sha256, manifestSha256: manifest.sha256 }) + "\n");
}
main().catch(() => { process.stdout.write('{"status":"INCOMPLETE","reason":"LOCAL_ARTIFACT_FAILURE"}\n'); process.exitCode = 1; });
