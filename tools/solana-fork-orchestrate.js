#!/usr/bin/env node
// Orchestrates a local Solana fork for Kamino Klend liquidation testing.
// No-key, read-only by default. Uses raw JSON-RPC (no @solana/web3.js dependency).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SCRIPT_DIR = __dirname;
const WORKSPACE = path.resolve(SCRIPT_DIR, "..");
const VALIDATOR_BIN = path.join(
  WORKSPACE,
  "tools", "solana", "releases", "3.1.14", "solana-release", "bin",
  "solana-test-validator.exe"
);
const KEYGEN_BIN = path.join(
  WORKSPACE,
  "tools", "solana", "releases", "3.1.14", "solana-release", "bin",
  "solana-keygen.exe"
);
const SO_FILE = path.join(WORKSPACE, "targets", "kamino-klend", "target", "deploy", "kamino_lending.so");
const STATUS_FILE = path.join(WORKSPACE, "reports", "monitor", "solana-fork-status.json");
const RPC_URL = "http://127.0.0.1:8899";
const PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const VALIDATOR_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const ARGS = new Set(process.argv.slice(2));
const FLAG_CHECK_ENV = ARGS.has("--check-env");
const FLAG_START_VALIDATOR = ARGS.has("--start-validator");
const FLAG_STOP_VALIDATOR = ARGS.has("--stop-validator");
const FLAG_FORK_TEST = ARGS.has("--fork-test");
const FLAG_QUIET = ARGS.has("--quiet");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(...args) {
  if (!FLAG_QUIET) console.log(...args);
}

function warn(...args) {
  if (!FLAG_QUIET) console.warn(...args);
}

function ts() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- Base58 encode (Uint8Array/Buffer -> string) -----
function base58Encode(buf) {
  const digits = [0];
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  // Leading zero bytes -> '1'
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    digits.push(0);
  }
  return digits.reverse().map((d) => BASE58_ALPHABET[d]).join("");
}

// ----- Generate a throwaway ed25519 test keypair (no file written) -----
function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  // ed25519 PKCS8 private key: 48 bytes header || 32 bytes seed
  // SPKI public key: 44 bytes header || 32 bytes raw pubkey
  const seed = privateKey.subarray(16, 48); // offset 16 for PKCS8 header
  const rawPubkey = publicKey.subarray(12, 44); // offset 12 for SPKI header
  const solanaKeypair = Buffer.alloc(64);
  seed.copy(solanaKeypair, 0);
  rawPubkey.copy(solanaKeypair, 32);
  return { pubkey: Buffer.from(rawPubkey), pubkeyB58: base58Encode(rawPubkey), keypairBytes: solanaKeypair };
}

// ----- Raw JSON-RPC call via fetch -----
async function rpcCall(method, params = [], timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.error) throw new Error(`RPC ${json.error.code}: ${json.error.message}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// ----- Spawn sync helper -----
function runSync(bin, args = [], opts = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...opts });
  return result;
}

// ----- Check if a process is listening on port 8899 -----
function isPort8899InUse() {
  try {
    const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return null; // indeterminate
    const lines = r.stdout.split("\n").filter((l) => l.includes("8899") && l.includes("LISTENING"));
    return lines.length > 0;
  } catch {
    return null;
  }
}

// ----- Kill solana-test-validator processes -----
function stopValidator() {
  log("[stop] Stopping solana-test-validator (taskkill)...");
  const r = spawnSync("taskkill", ["/F", "/IM", "solana-test-validator.exe"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status === 0) {
    log("[stop] Validator process(es) terminated.");
    return true;
  }
  if (r.stderr && r.stderr.includes("not found")) {
    warn("[stop] No running solana-test-validator process found.");
    return false;
  }
  warn("[stop] taskkill exit code " + r.status + ": " + (r.stderr || r.stdout || ""));
  return false;
}

// ----- Wait for validator health -----
async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await rpcCall("getHealth", [], 2000);
      if (result === "ok") return true;
    } catch {
      // not ready yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

// ----- Check validator process status -----
async function isValidatorRunning() {
  try {
    const result = await rpcCall("getHealth", [], 3000);
    return result === "ok";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function defaultStatus() {
  return {
    generatedAt: ts(),
    environment: { validatorBinaryExists: false, soFileExists: false, port8899Free: null },
    validator: { running: false },
    program: { deployed: false },
    forkTest: { run: false, result: null },
    ready: false,
    nextStep: "",
  };
}

function writeStatus(status) {
  status.generatedAt = ts();
  try {
    const dir = path.dirname(STATUS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf8");
  } catch (err) {
    warn("[status] Failed to write status file:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Environment Check
// ---------------------------------------------------------------------------
function checkEnvironment() {
  log("\n=== Phase 1: Environment Check ===\n");

  const env = { validatorBinaryExists: false, soFileExists: false, port8899Free: null };

  // 1. Validator binary
  env.validatorBinaryExists = fs.existsSync(VALIDATOR_BIN);
  log(`[env] solana-test-validator.exe: ${env.validatorBinaryExists ? "FOUND" : "NOT FOUND"}`);
  if (!env.validatorBinaryExists) {
    warn(`[env]   Expected at: ${VALIDATOR_BIN}`);
  }

  // 2. .so file
  env.soFileExists = fs.existsSync(SO_FILE);
  log(`[env] kamino_lending.so:       ${env.soFileExists ? "FOUND" : "NOT FOUND"}`);
  if (!env.soFileExists) {
    warn("[env]   Build with: cd targets/kamino-klend && cargo build-bpf");
  }

  // 3. Port 8899
  const portStatus = isPort8899InUse();
  if (portStatus === true) {
    env.port8899Free = false;
    log("[env] Port 8899: IN USE (validator may already be running)");
  } else if (portStatus === false) {
    env.port8899Free = true;
    log("[env] Port 8899: FREE");
  } else {
    env.port8899Free = null;
    warn("[env] Port 8899: UNKNOWN (netstat failed)");
  }

  return env;
}

// ---------------------------------------------------------------------------
// Phase 2: Start Validator
// ---------------------------------------------------------------------------
async function startValidator() {
  log("\n=== Phase 2: Start Validator ===\n");

  // Check if already running
  const running = await isValidatorRunning();
  if (running) {
    log("[val] Validator already running on port 8899");
    return { running: true, alreadyRunning: true };
  }

  // Validate binary exists
  if (!fs.existsSync(VALIDATOR_BIN)) {
    warn("[val] Fatal: solana-test-validator.exe not found at:");
    warn(`       ${VALIDATOR_BIN}`);
    return { running: false, error: "Binary not found" };
  }

  // Check .so
  const soExists = fs.existsSync(SO_FILE);
  if (!soExists) {
    warn("[val] kamino_lending.so not found. Build with:");
    warn("       cd targets/kamino-klend && cargo build-bpf");
    warn("[val] Starting validator without program (deploy will be skipped)");
  }

  // Build args
  const args = ["--reset", "-r"];
  if (soExists) {
    args.push("--bpf-program", PROGRAM_ID, SO_FILE);
  }

  // Quote the binary path if it contains spaces
  const binPath = VALIDATOR_BIN.includes(" ") ? `"${VALIDATOR_BIN}"` : VALIDATOR_BIN;

  log("[val] Starting validator...");
  log(`[val] Command: ${binPath} ${args.slice(0, 4).join(" ")} ...`);

  // Spawn detached so it survives this script
  const child = spawn(VALIDATOR_BIN, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  log("[val] Waiting for validator health (timeout: " + (VALIDATOR_TIMEOUT_MS / 1000) + "s)...");

  const healthy = await waitForHealth(VALIDATOR_TIMEOUT_MS);
  if (!healthy) {
    warn("[val] Validator did not become healthy within timeout");
    return { running: false, error: "Health check timeout" };
  }

  log("[val] Validator is healthy on " + RPC_URL);
  return { running: true, alreadyRunning: false };
}

// ---------------------------------------------------------------------------
// Phase 3: Fork Test Scaffold (read-only)
// ---------------------------------------------------------------------------
async function forkTest() {
  log("\n=== Phase 3: Fork Test Scaffold ===\n");

  const result = { attempts: {}, accountReads: {} };

  // 1. Generate throwaway test keypair
  const testKp = generateTestKeypair();
  log(`[test] Generated test keypair: ${testKp.pubkeyB58}`);

  // 2. Airdrop SOL
  try {
    const sig = await rpcCall("requestAirdrop", [testKp.pubkeyB58, 5_000_000_000], 30000);
    log(`[test] Airdrop requested: ${sig}`);
    result.attempts.airdrop = { ok: true, sig };
  } catch (err) {
    warn(`[test] Airdrop failed: ${err.message}`);
    result.attempts.airdrop = { ok: false, error: err.message };
  }

  // 3. Read deployed program account
  try {
    const accountInfo = await rpcCall("getAccountInfo", [PROGRAM_ID, { encoding: "base64" }], 10000);
    const found = accountInfo !== null && accountInfo !== undefined;
    log(`[test] Program account (${PROGRAM_ID}): ${found ? "FOUND" : "NOT FOUND"}`);
    result.accountReads.program = { ok: found, exists: found };
    if (found) {
      result.accountReads.program.lamports = accountInfo.lamports;
      result.accountReads.program.executable = accountInfo.executable;
      result.accountReads.program.dataLen = accountInfo.data?.length || 0;
    }
  } catch (err) {
    warn(`[test] Program account read failed: ${err.message}`);
    result.accountReads.program = { ok: false, exists: null, error: err.message };
  }

  // 4. Read lending market account
  try {
    const marketInfo = await rpcCall("getAccountInfo", [MAIN_MARKET, { encoding: "base64" }], 10000);
    const found = marketInfo !== null && marketInfo !== undefined;
    log(`[test] Lending market (${MAIN_MARKET}): ${found ? "FOUND" : "NOT FOUND"}`);
    result.accountReads.lendingMarket = { ok: found, exists: found };
    if (found) {
      result.accountReads.lendingMarket.lamports = marketInfo.lamports;
      result.accountReads.lendingMarket.dataLen = marketInfo.data?.length || 0;
    }
  } catch (err) {
    warn(`[test] Lending market read failed: ${err.message}`);
    result.accountReads.lendingMarket = { ok: false, exists: null, error: err.message };
  }

  // 5. Print test plan
  const programOk = result.accountReads.program?.exists === true;
  const marketOk = result.accountReads.lendingMarket?.exists === true;
  log("\n--- Fork Test Plan (read-only scaffold) ---");
  log("  Phase A: Obligation scanning via getProgramAccounts (filters on lending market)");
  log("  Phase B: Reserve decoding + price oracle sanity checks");
  log("  Phase C: Obligation parsing, LTV computation, liquidation threshold comparison");
  log("  Phase D: Candidate liquidation plan construction");
  log("  Phase E: Simulation of liquidation transaction (no send)");
  log(`  Preconditions met: ${programOk && marketOk ? "YES" : "NO"}`);
  if (!programOk) log("    - Program account not deployed");
  if (!marketOk) log("    - Lending market account not available");
  log("");

  result.ready = programOk && marketOk;
  result.plan = [
    "Phase A: Obligation scanning via getProgramAccounts (filters on lending market)",
    "Phase B: Reserve decoding + price oracle sanity checks",
    "Phase C: Obligation parsing, LTV computation, liquidation threshold comparison",
    "Phase D: Candidate liquidation plan construction",
    "Phase E: Simulation of liquidation transaction (no send)",
  ];

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const status = defaultStatus();

  // -- Build build instruction string
  const buildCmd = "cd targets/kamino-klend && cargo build-bpf";

  // --stop-validator (fast, no env checks needed)
  if (FLAG_STOP_VALIDATOR) {
    stopValidator();
    // Re-check port after stopping
    await sleep(500);
    const portFree = isPort8899InUse();
    status.environment.port8899Free = portFree !== true;
    status.validator.running = !(portFree === false || portFree === null);
    writeStatus(status);
    return;
  }

  // Phase 1: Environment check
  const env = checkEnvironment();
  status.environment = env;

  if (FLAG_CHECK_ENV) {
    // Determine readiness
    const soFileExists = env.soFileExists;
    const port8899Free = env.port8899Free;
    const valBinaryExists = env.validatorBinaryExists;
    const ready = valBinaryExists && soFileExists;
    status.ready = ready;
    status.nextStep = ready
      ? "Run with --start-validator [--fork-test] to launch the local fork"
      : soFileExists
        ? "solana-test-validator.exe missing. Check Solana release path."
        : buildCmd;
    writeStatus(status);

    log("\n=== Summary ===");
    log(`  Validator binary: ${env.validatorBinaryExists ? "OK" : "MISSING"}`);
    log(`  kamino_lending.so: ${env.soFileExists ? "OK" : "MISSING"}`);
    log(`  Port 8899: ${env.port8899Free === true ? "FREE" : env.port8899Free === false ? "IN USE" : "UNKNOWN"}`);
    log(`  Ready to fork: ${ready ? "YES" : "NO"}`);
    if (!ready) log(`  Next step: ${status.nextStep}`);
    return;
  }

  // Phase 2: Start validator (if requested)
  if (FLAG_START_VALIDATOR) {
    const valStatus = await startValidator();
    status.validator.running = valStatus.running;
    status.validator.startError = valStatus.error || null;

    if (!valStatus.running) {
      status.ready = false;
      status.nextStep = valStatus.error || "Validator failed to start";
      writeStatus(status);
      warn("\n[abort] Validator failed to start. See errors above.");
      return;
    }

    // Check if program deployed
    if (valStatus.alreadyRunning) {
      // Check program account
      try {
        const info = await rpcCall("getAccountInfo", [PROGRAM_ID, { encoding: "base64" }], 5000);
        status.program.deployed = info !== null && info !== undefined;
      } catch {
        status.program.deployed = false;
      }
    } else {
      // We loaded it via --bpf-program, but confirm
      await sleep(2000);
      try {
        const info = await rpcCall("getAccountInfo", [PROGRAM_ID, { encoding: "base64" }], 5000);
        status.program.deployed = info !== null && info !== undefined;
      } catch {
        status.program.deployed = false;
      }
    }
  } else {
    // Check if validator is already running
    status.validator.running = await isValidatorRunning();
    if (status.validator.running) {
      try {
        const info = await rpcCall("getAccountInfo", [PROGRAM_ID, { encoding: "base64" }], 5000);
        status.program.deployed = info !== null && info !== undefined;
      } catch {
        status.program.deployed = false;
      }
    }
  }

  // Phase 3: Fork test (if requested)
  if (FLAG_FORK_TEST) {
    if (!status.validator.running) {
      warn("\n[test] Validator is not running. Use --start-validator first.");
      status.forkTest.run = false;
      status.forkTest.result = { error: "Validator not running" };
    } else {
      const ftResult = await forkTest();
      status.forkTest.run = true;
      status.forkTest.result = ftResult;
    }
  }

  // Determine overall readiness
  const soFileExists = fs.existsSync(SO_FILE);
  status.ready =
    status.validator.running &&
    status.program.deployed &&
    (!FLAG_FORK_TEST || status.forkTest.run === true);

  if (!status.ready) {
    if (!fs.existsSync(VALIDATOR_BIN)) {
      status.nextStep = "Install solana-test-validator binary";
    } else if (!soFileExists) {
      status.nextStep = buildCmd;
    } else if (!status.validator.running) {
      status.nextStep = "Run with --start-validator to launch local fork";
    } else if (!status.program.deployed) {
      status.nextStep = `Deploy ${SO_FILE} with --bpf-program ${PROGRAM_ID}`;
    } else {
      status.nextStep = "All checks passed — run with --fork-test to test";
    }
  } else {
    status.nextStep = "Ready. Use --fork-test to re-run the test scaffold.";
  }

  writeStatus(status);

  log("\n=== Done ===");
  log(`Status written to: ${STATUS_FILE}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
